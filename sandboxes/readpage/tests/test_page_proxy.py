"""Tests of PageProxy over loopback sockets, with ranges and names of their own.

The ranges block only ``::1``, so a target on ``127.0.0.1`` plays a public
server and one on ``::1`` a private one, and a lookup of its own maps the
names ``public.test``, ``private.test``, and ``mixed.test`` to them.
"""

import ipaddress
import socket
import threading
import unittest
from collections.abc import Callable, Sequence

import connection_gate
from connection_gate import HostAddress
from page_proxy import PageProxy
from web_addresses import BlockedAddressRanges

# Ranges that block the IPv6 loopback address alone.
TEST_RANGES = BlockedAddressRanges(
    ipv4_networks=(), ipv6_networks=(ipaddress.IPv6Network("::1/128"),)
)

# Seconds a test socket waits before the case fails instead of hanging.
TEST_SOCKET_TIMEOUT_SECONDS = 5

# Most bytes read from a test socket at a time.
TEST_READ_BYTE_COUNT = 65_536


def list_test_host_addresses(host: str, port: int) -> Sequence[HostAddress]:
    """Resolves the test names to the loopback targets.

    Args:
        host: ``public.test``, ``private.test``, ``mixed.test``, an IP
            address, or another name, which has no address.
        port: The target's port.

    Returns:
        The name's addresses with that port.

    Raises:
        OSError: The name is not one of the test names or an IP address.
    """
    public_address = HostAddress(socket.AF_INET, ("127.0.0.1", port))
    private_address = HostAddress(socket.AF_INET6, ("::1", port, 0, 0))
    addresses = {
        "public.test": [public_address],
        "private.test": [private_address],
        "mixed.test": [public_address, private_address],
        "127.0.0.1": [public_address],
        "::1": [private_address],
    }
    if host not in addresses:
        raise socket.gaierror(socket.EAI_NONAME, "Name does not resolve")
    return addresses[host]


class TargetServer:
    """A server that runs a handler for each connection and counts them.

    It owns its listener and threads; close() wakes its accept loop with a
    connection of its own, which is not counted, and joins every thread.
    """

    def __init__(
        self, family: int, host: str, handler: Callable[[socket.socket], None]
    ) -> None:
        """Starts listening on a free port.

        Args:
            family: Address family of host.
            host: Loopback address to listen on.
            handler: Runs once per connection, in a thread of its own, and
                may close it; the server closes it afterwards.
        """
        self._listener = socket.create_server((host, 0), family=family)
        self._host = host
        self._handler = handler
        self._lock = threading.Lock()
        self._connection_count = 0
        self._is_closing = False
        self._threads: list[threading.Thread] = []
        self._accept_thread = threading.Thread(target=self._accept_connections)
        self._accept_thread.start()

    @property
    def port(self) -> int:
        """The port it listens on."""
        return self._listener.getsockname()[1]

    @property
    def connection_count(self) -> int:
        """How many connections it accepted so far."""
        with self._lock:
            return self._connection_count

    def close(self) -> None:
        """Stops accepting and waits for every handler."""
        with self._lock:
            self._is_closing = True
        socket.create_connection((self._host, self.port)).close()
        self._accept_thread.join()
        self._listener.close()
        for thread in self._threads:
            thread.join()

    def _accept_connections(self) -> None:
        """Accepts connections until close() wakes it."""
        while True:
            connection, _ = self._listener.accept()
            with self._lock:
                if self._is_closing:
                    connection.close()
                    return
                self._connection_count += 1
            thread = threading.Thread(target=self._serve, args=(connection,))
            thread.start()
            self._threads.append(thread)

    def _serve(self, connection: socket.socket) -> None:
        """Runs the handler on one connection and closes it."""
        with connection:
            connection.settimeout(TEST_SOCKET_TIMEOUT_SECONDS)
            try:
                self._handler(connection)
            except OSError:
                return


def answer_hello(connection: socket.socket) -> None:
    """Reads one request head and answers ``hello`` with a keep-alive head.

    Args:
        connection: A connection from the proxy.
    """
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = connection.recv(TEST_READ_BYTE_COUNT)
        if not chunk:
            return
        request += chunk
    connection.sendall(
        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive\r\n"
        b"Keep-Alive: timeout=5\r\nX-Request-Line: "
        + request.split(b"\r\n")[0].replace(b" ", b"_")
        + b"\r\n\r\nhello"
    )


def echo_bytes(connection: socket.socket) -> None:
    """Sends back every byte it receives until the proxy closes.

    Args:
        connection: A connection from the proxy.
    """
    while chunk := connection.recv(TEST_READ_BYTE_COUNT):
        connection.sendall(chunk)


def read_until_closed(connection: socket.socket) -> bytes:
    """Reads a connection until its other side closes it.

    Args:
        connection: A client connection to the proxy.

    Returns:
        Every byte received.
    """
    received = bytearray()
    while chunk := connection.recv(TEST_READ_BYTE_COUNT):
        received += chunk
    return bytes(received)


class PageProxyTestCase(unittest.TestCase):
    """Starts a proxy and the two targets for each case, closing them after."""

    def setUp(self) -> None:
        self.proxy = PageProxy.open(TEST_RANGES, list_test_host_addresses)
        self.addCleanup(self.proxy.close)
        self.public_server = self.start_server(
            socket.AF_INET, "127.0.0.1", answer_hello
        )
        self.private_server = self.start_server(socket.AF_INET6, "::1", answer_hello)

    def start_server(
        self, family: int, host: str, handler: Callable[[socket.socket], None]
    ) -> TargetServer:
        """Starts a target that the case's cleanup closes."""
        server = TargetServer(family, host, handler)
        self.addCleanup(server.close)
        return server

    def connect_to_proxy(self) -> socket.socket:
        """Opens a client connection to the proxy that the case's cleanup closes."""
        port = int(self.proxy.url.rsplit(":", 1)[1])
        client = socket.create_connection(
            ("127.0.0.1", port), timeout=TEST_SOCKET_TIMEOUT_SECONDS
        )
        self.addCleanup(client.close)
        return client

    def send_to_proxy(self, request: bytes) -> bytes:
        """Sends one request on a new connection and reads it to its end."""
        client = self.connect_to_proxy()
        client.sendall(request)
        return read_until_closed(client)


class ForwardingTests(PageProxyTestCase):
    """Requests to targets the rule allows reach them."""

    def test_forwards_a_plain_http_request_in_origin_form(self) -> None:
        port = self.public_server.port
        response = self.send_to_proxy(
            f"GET http://public.test:{port}/page?x=1 HTTP/1.1\r\n"
            f"Host: public.test:{port}\r\nProxy-Connection: keep-alive\r\n\r\n".encode()
        )
        head, _, body = response.partition(b"\r\n\r\n")
        self.assertEqual(body, b"hello")
        self.assertIn(b"X-Request-Line: GET_/page?x=1_HTTP/1.1", head)
        self.assertIn(b"Connection: close", head)
        self.assertNotIn(b"keep-alive", head.lower())

    def test_tunnels_a_connect_request(self) -> None:
        echo_server = self.start_server(socket.AF_INET, "127.0.0.1", echo_bytes)
        client = self.connect_to_proxy()
        client.sendall(
            f"CONNECT public.test:{echo_server.port} HTTP/1.1\r\n\r\n".encode()
        )
        self.assertEqual(
            client.recv(TEST_READ_BYTE_COUNT),
            b"HTTP/1.1 200 Connection Established\r\n\r\n",
        )
        client.sendall(b"ping")
        self.assertEqual(client.recv(TEST_READ_BYTE_COUNT), b"ping")


class RefusalTests(PageProxyTestCase):
    """Requests whose target has a blocked address are never connected to."""

    def assert_refused(self, request: bytes, url: str) -> None:
        """Checks that the proxy closed the request unanswered and recorded it."""
        self.assertEqual(self.send_to_proxy(request), b"")
        self.assertTrue(self.proxy.has_refused(url))
        self.assertEqual(self.private_server.connection_count, 0)

    def test_refuses_a_tunnel_to_a_name_with_a_blocked_address(self) -> None:
        port = self.private_server.port
        self.assert_refused(
            f"CONNECT private.test:{port} HTTP/1.1\r\n\r\n".encode(),
            f"https://private.test:{port}/",
        )

    def test_refuses_a_request_to_a_name_with_one_blocked_address_of_two(self) -> None:
        port = self.private_server.port
        self.assert_refused(
            f"GET http://mixed.test:{port}/ HTTP/1.1\r\nHost: mixed.test\r\n\r\n".encode(),
            f"http://mixed.test:{port}/",
        )
        self.assertEqual(self.public_server.connection_count, 0)

    def test_refuses_a_blocked_ip_literal(self) -> None:
        port = self.private_server.port
        self.assert_refused(
            f"CONNECT [::1]:{port} HTTP/1.1\r\n\r\n".encode(), f"https://[::1]:{port}/"
        )

    def test_does_not_record_a_name_without_an_address(self) -> None:
        self.assertEqual(
            self.send_to_proxy(b"CONNECT missing.test:443 HTTP/1.1\r\n\r\n"), b""
        )
        self.assertFalse(self.proxy.has_refused("https://missing.test/"))

    def test_closes_requests_it_does_not_serve(self) -> None:
        port = self.public_server.port
        requests = {
            "a malformed request line": b"GET\r\n\r\n",
            "an https URL": f"GET https://public.test:{port}/ HTTP/1.1\r\n\r\n",
            "a chunked body": (
                f"POST http://public.test:{port}/ HTTP/1.1\r\n"
                "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
            ),
            "a folded header": (
                f"GET http://public.test:{port}/ HTTP/1.1\r\nA: b\r\n c\r\n\r\n"
            ),
        }
        for label, request in requests.items():
            with self.subTest(label):
                encoded = request if isinstance(request, bytes) else request.encode()
                self.assertEqual(self.send_to_proxy(encoded), b"")
        self.assertEqual(self.public_server.connection_count, 0)


class BoundTests(PageProxyTestCase):
    """The proxy keeps one read within its connection and byte bounds."""

    def open_tunnel(self, port: int) -> socket.socket:
        """Asks the proxy for a tunnel to the public target on a port."""
        client = self.connect_to_proxy()
        client.sendall(f"CONNECT public.test:{port} HTTP/1.1\r\n\r\n".encode())
        return client

    def test_opens_the_last_connection_within_the_bound_and_refuses_the_next(
        self,
    ) -> None:
        echo_server = self.start_server(socket.AF_INET, "127.0.0.1", echo_bytes)
        for _ in range(connection_gate.MAXIMUM_CONNECTION_COUNT):
            client = self.open_tunnel(echo_server.port)
            self.assertTrue(
                client.recv(TEST_READ_BYTE_COUNT).startswith(b"HTTP/1.1 200")
            )
            client.close()
        self.assertEqual(read_until_closed(self.open_tunnel(echo_server.port)), b"")
        self.assertEqual(
            echo_server.connection_count, connection_gate.MAXIMUM_CONNECTION_COUNT
        )
        self.assert_not_served(echo_server)

    def test_passes_bytes_up_to_the_received_bound(self) -> None:
        bound = connection_gate.MAXIMUM_RECEIVED_BYTE_COUNT
        sender = self.start_server(
            socket.AF_INET,
            "127.0.0.1",
            lambda connection: connection.sendall(bytes(bound)),
        )
        client = self.open_tunnel(sender.port)
        received = read_until_closed(client)
        self.assertEqual(
            len(received), len(b"HTTP/1.1 200 Connection Established\r\n\r\n") + bound
        )

    def test_ends_the_read_past_the_received_bound(self) -> None:
        bound = connection_gate.MAXIMUM_RECEIVED_BYTE_COUNT
        sender = self.start_server(
            socket.AF_INET,
            "127.0.0.1",
            lambda connection: connection.sendall(bytes(bound + 1)),
        )
        client = self.open_tunnel(sender.port)
        received = read_until_closed(client)
        self.assertLessEqual(
            len(received), len(b"HTTP/1.1 200 Connection Established\r\n\r\n") + bound
        )
        self.assert_not_served(sender)

    def assert_not_served(self, server: TargetServer) -> None:
        """Checks that a stopped proxy serves no further tunnel to a target.

        The proxy closes its listener once its gate stops, but in its own
        thread, so a connection may still reach the listener and be closed
        or reset instead of refused.
        """
        connection_count = server.connection_count
        try:
            received = read_until_closed(self.open_tunnel(server.port))
        except (ConnectionRefusedError, ConnectionResetError):
            received = b""
        self.assertEqual(received, b"")
        self.assertEqual(server.connection_count, connection_count)


class CloseTests(PageProxyTestCase):
    """close() ends every connection and can run twice."""

    def test_close_ends_an_open_tunnel(self) -> None:
        echo_server = self.start_server(socket.AF_INET, "127.0.0.1", echo_bytes)
        client = self.connect_to_proxy()
        client.sendall(
            f"CONNECT public.test:{echo_server.port} HTTP/1.1\r\n\r\n".encode()
        )
        self.assertTrue(client.recv(TEST_READ_BYTE_COUNT).startswith(b"HTTP/1.1 200"))
        self.proxy.close()
        self.assertEqual(read_until_closed(client), b"")
        self.proxy.close()


if __name__ == "__main__":
    unittest.main()
