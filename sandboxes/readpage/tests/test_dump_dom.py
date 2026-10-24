"""Tests of dump_dom.py reading pages in Chromium through its proxy.

Each case copies the reader's files into a temporary directory laid out as
the image's /app and runs dump_dom.py there, as endpoint.sh does. Pages come
from a server on 127.0.0.1. The cases with ranges of their own block only
``::1``, where a second server stands for a private address and counts the
connections it gets. They need ``chromium-headless-shell`` on PATH, as the
image has it, and are skipped without it.
"""

import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# The reader's directory and the backend's web module, in the repository.
READER_DIRECTORY = Path(__file__).resolve().parents[1]
BACKEND_WEB_DIRECTORY = (
    Path(__file__).resolve().parents[3] / "apps/backend/src/modules/tool/builtIn/web"
)

# Files the image copies to /app from the reader's directory.
READER_FILE_NAMES = (
    "connection_gate.py",
    "dump_dom.py",
    "flatten_dom.js",
    "page_proxy.py",
    "proxy_http.py",
    "web_addresses.py",
)

# Ranges that block the IPv6 loopback address alone.
TEST_RANGES = {"ipv4": [], "ipv6": ["::1/128"]}

# Seconds one read may take before the case fails.
READ_TIMEOUT_SECONDS = 60

# The exit code the backend reports as blocked-address.
BLOCKED_ADDRESS_EXIT_CODE = json.loads(
    (BACKEND_WEB_DIRECTORY / "page_reader_exit_codes.json").read_text("utf-8")
)["blockedAddress"]


class CountingServer(ThreadingHTTPServer):
    """An HTTP server that counts the connections it accepts.

    Its pages come from its ``pages`` mapping: a path to the status, headers,
    and body it answers with.
    """

    daemon_threads = True

    def __init__(self, address: tuple[str, int], family: int) -> None:
        """Listens on a free port of a loopback address.

        Args:
            address: Host and port 0.
            family: Address family of the host.
        """
        self.address_family = family
        super().__init__(address, PageRequestHandler)
        self.pages: dict[str, tuple[int, dict[str, str], str]] = {}
        self._lock = threading.Lock()
        self._connection_count = 0

    @property
    def connection_count(self) -> int:
        """How many connections it accepted so far."""
        with self._lock:
            return self._connection_count

    def verify_request(self, request: object, client_address: object) -> bool:
        """Counts each accepted connection before it is served."""
        with self._lock:
            self._connection_count += 1
        return True


class PageRequestHandler(BaseHTTPRequestHandler):
    """Answers GET requests from the server's pages; other paths get 404."""

    def do_GET(self) -> None:
        """Answers one page."""
        status, headers, body = self.server.pages.get(self.path, (404, {}, "not found"))
        encoded_body = body.encode("utf-8")
        self.send_response(status)
        for name, value in {"Content-Type": "text/html", **headers}.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(encoded_body)))
        self.end_headers()
        self.wfile.write(encoded_body)

    def log_message(self, format: str, *args: object) -> None:
        """Keeps request lines out of the test output."""


@unittest.skipUnless(
    shutil.which("chromium-headless-shell"),
    "chromium-headless-shell is not on PATH, so no page can be read",
)
class DumpDomTestCase(unittest.TestCase):
    """Starts the public and private servers for each case."""

    def setUp(self) -> None:
        self.public_server = self.start_server(("127.0.0.1", 0), socket.AF_INET)
        self.private_server = self.start_server(("::1", 0), socket.AF_INET6)
        self.private_server.pages["/secret"] = (200, {}, "<p>router admin</p>")
        self.private_url = f"http://[::1]:{self.private_server.server_port}/secret"

    def start_server(self, address: tuple[str, int], family: int) -> CountingServer:
        """Starts a server that the case's cleanup stops."""
        server = CountingServer(address, family)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def public_url(self, path: str) -> str:
        """The URL of a path on the public server."""
        return f"http://127.0.0.1:{self.public_server.server_port}{path}"

    def read_page(
        self, url: str, ranges: dict[str, list[str]] | None
    ) -> subprocess.CompletedProcess[str]:
        """Runs dump_dom.py on a URL in a copy of the image's layout.

        Args:
            url: The page to read.
            ranges: Blocked ranges of the case's own; the backend's file when
                None.

        Returns:
            The finished reader, with its output as text.
        """
        with tempfile.TemporaryDirectory() as directory:
            for name in READER_FILE_NAMES:
                shutil.copy(READER_DIRECTORY / name, directory)
            shutil.copy(
                BACKEND_WEB_DIRECTORY / "page_reader_exit_codes.json", directory
            )
            ranges_path = Path(directory, "blocked_address_ranges.json")
            if ranges is None:
                shutil.copy(BACKEND_WEB_DIRECTORY / ranges_path.name, ranges_path)
            else:
                ranges_path.write_text(json.dumps(ranges), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(Path(directory, "dump_dom.py")), url],
                capture_output=True,
                text=True,
                timeout=READ_TIMEOUT_SECONDS,
                check=False,
            )

    def assert_blocked(self, reader: subprocess.CompletedProcess[str]) -> None:
        """Checks that a read failed as blocked-address and wrote no page."""
        self.assertEqual(reader.returncode, BLOCKED_ADDRESS_EXIT_CODE, reader.stderr)
        self.assertTrue(reader.stderr.startswith("Error: "), reader.stderr)
        self.assertEqual(reader.stdout, "")


class BlockedNavigationTests(DumpDomTestCase):
    """A read that ends on a blocked address fails without connecting to it."""

    def test_refuses_a_redirect_to_a_private_address(self) -> None:
        self.public_server.pages["/redirect"] = (
            302,
            {"Location": self.private_url},
            "",
        )
        reader = self.read_page(self.public_url("/redirect"), TEST_RANGES)
        self.assert_blocked(reader)
        self.assertEqual(self.private_server.connection_count, 0)

    def test_refuses_a_meta_refresh_to_a_private_address(self) -> None:
        self.public_server.pages["/refresh"] = (
            200,
            {},
            f'<meta http-equiv="refresh" content="0; url={self.private_url}">'
            "<p>moving</p>",
        )
        reader = self.read_page(self.public_url("/refresh"), TEST_RANGES)
        self.assert_blocked(reader)
        self.assertEqual(self.private_server.connection_count, 0)

    def test_refuses_a_loopback_page_by_the_backend_ranges(self) -> None:
        self.public_server.pages["/page"] = (200, {}, "<p>local</p>")
        reader = self.read_page(self.public_url("/page"), None)
        self.assert_blocked(reader)
        self.assertEqual(self.public_server.connection_count, 0)


class BlockedSubresourceTests(DumpDomTestCase):
    """A page whose resources are at a blocked address is read without them."""

    def test_reads_the_page_and_refuses_its_blocked_resources(self) -> None:
        self.public_server.pages["/page"] = (
            200,
            {},
            f'<p>public text</p><img src="{self.private_url}">'
            f'<script>fetch("{self.private_url}").catch(() => {{}})</script>',
        )
        reader = self.read_page(self.public_url("/page"), TEST_RANGES)
        self.assertEqual(reader.returncode, 0, reader.stderr)
        self.assertIn("<p>public text</p>", reader.stdout)
        self.assertNotIn("router admin", reader.stdout)
        self.assertEqual(self.private_server.connection_count, 0)


if __name__ == "__main__":
    unittest.main()
