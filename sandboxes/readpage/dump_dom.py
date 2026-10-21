"""Writes the HTML of a page as headless Chromium renders it.

The reader's entrypoint runs ``python3 dump_dom.py <url>`` and pipes standard
output to parse_dom.py. The page is loaded with the steps Chromium's own
``--dump-dom --virtual-time-budget=10000`` takes: a new tab opens on
``about:blank`` and navigates to the URL; once the main frame has fired
``load``, the page's timers run for 10 seconds of virtual time, which pauses
while a network fetch is pending. flatten_dom.js then builds the HTML in a
script world of the reader's own, with the page's open shadow roots
flattened, where ``--dump-dom`` would write ``document.documentElement``'s
``outerHTML``.

It exits with 0 after writing the HTML and a newline as UTF-8. It exits with
1 and ``Error: <reason>`` on standard error, having written nothing, when
Chromium cannot load the page, the URL starts a download, Chromium refuses a
DevTools command, the page's renderer crashes, Chromium closes its DevTools
pipe, or the page script fails. Chromium's own messages are discarded.
"""

import json
import os
import subprocess
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

# The shell moves the DevTools pipe to the descriptors Chromium's
# --remote-debugging-pipe reads and writes, 3 and 4, and puts Chromium's
# standard input and output on /dev/null. --disable-lazy-loading is the
# switch headless Chromium adds for --dump-dom, so images and frames below
# the viewport load too.
CHROMIUM_COMMAND = (
    "sh",
    "-c",
    'exec "$@" 3<&0 4>&1 0</dev/null 1>/dev/null',
    "sh",
    "chromium-headless-shell",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-lazy-loading",
    "--remote-debugging-pipe",
)

# Virtual time policy set once the main frame has fired load, as
# --virtual-time-budget=10000 sets it: the page's timers run for 10,000
# milliseconds of virtual time, which stands still while a network fetch is
# pending, and Chromium moves virtual time forward after 9,999 tasks run
# without it moving, so a page that keeps posting tasks cannot hold it back.
VIRTUAL_TIME_POLICY: Mapping[str, Any] = {
    "budget": 10_000,
    "maxVirtualTimeTaskStarvationCount": 9_999,
    "policy": "pauseIfNetworkFetchesPending",
}

# Seconds Chromium has to exit once its DevTools pipe is closed before it is
# killed. It usually exits within a tenth of a second.
CHROMIUM_EXIT_TIMEOUT_SECONDS = 5

# Most bytes read from the DevTools pipe at a time.
READ_CHUNK_BYTE_COUNT = 65_536

# Name of the script world flatten_dom.js runs in, which the page's own
# scripts cannot reach.
PAGE_SCRIPT_WORLD_NAME = "lys-read-page"

# The page script, which the image copies next to this file.
PAGE_SCRIPT_PATH = Path(__file__).with_name("flatten_dom.js")

# Event Chromium sends when the renderer of a tab crashes. It answers no
# command to that tab afterwards, so the read cannot go on.
RENDERER_CRASH_EVENT = "Inspector.targetCrashed"


class PageReadError(Exception):
    """The page could not be read; the message says why."""


class ChromiumDevToolsPipe:
    """Chromium's process and the DevTools pipe the reader drives it through.

    Messages are read only while a command's response or an event is awaited.
    Any other message read meanwhile is dropped, as Chromium's own command
    handler drops the events it has no listener for, except that a crash of
    the page's renderer ends any wait. Closing the pipe ends Chromium; so does
    the reader's death, which closes the pipe with it.
    """

    def __init__(
        self, process: subprocess.Popen[bytes], command_fd: int, message_fd: int
    ) -> None:
        """Takes ownership of a started Chromium and its pipe.

        Args:
            process: Chromium, started with --remote-debugging-pipe.
            command_fd: Write end of the pipe Chromium reads commands from.
            message_fd: Read end of the pipe Chromium writes messages to.
        """
        self._process = process
        self._command_fd = command_fd
        self._message_fd = message_fd
        self._unread_bytes = bytearray()
        self._last_command_id = 0
        self._is_closed = False

    def __enter__(self) -> "ChromiumDevToolsPipe":
        return self

    def __exit__(self, *exception_info: object) -> None:
        self.close()

    def send_command(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        session_id: str | None = None,
    ) -> Mapping[str, Any]:
        """Sends a DevTools command and waits for its response.

        Args:
            method: The command, such as ``Page.navigate``.
            params: The command's parameters; none when omitted.
            session_id: Session of the tab the command is for; the browser's
                own when omitted.

        Returns:
            The command's result.

        Raises:
            PageReadError: Chromium refused the command, the page's renderer
                crashed first, or the pipe failed.
        """
        self._last_command_id += 1
        command_id = self._last_command_id
        command: dict[str, Any] = {
            "id": command_id,
            "method": method,
            "params": params or {},
        }
        if session_id is not None:
            command["sessionId"] = session_id
        self._send_message(command)
        while True:
            message = self._read_message()
            if message.get("id") != command_id:
                continue
            if "error" in message:
                error = json.dumps(message["error"])
                raise PageReadError(f"Chromium refused {method}: {error}")
            return message["result"]

    def wait_for_event(
        self,
        method: str,
        session_id: str,
        is_awaited_event: Callable[[Mapping[str, Any]], bool] = lambda _: True,
    ) -> Mapping[str, Any]:
        """Waits for a tab's DevTools event.

        Args:
            method: The event, such as ``Page.lifecycleEvent``.
            session_id: Session of the tab the event comes from.
            is_awaited_event: Answers whether an event of that kind, given its
                parameters, is the one awaited; any is when omitted.

        Returns:
            The awaited event's parameters.

        Raises:
            PageReadError: The page's renderer crashed first, or the pipe
                failed.
        """
        while True:
            message = self._read_message()
            if message.get("method") != method:
                continue
            if message.get("sessionId") != session_id:
                continue
            params = message.get("params", {})
            if is_awaited_event(params):
                return params

    def close(self) -> None:
        """Closes the pipe and waits for Chromium to exit.

        Chromium is killed when it has not exited after
        CHROMIUM_EXIT_TIMEOUT_SECONDS. Closing again does nothing.
        """
        if self._is_closed:
            return
        self._is_closed = True
        os.close(self._command_fd)
        os.close(self._message_fd)
        try:
            self._process.wait(timeout=CHROMIUM_EXIT_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait()

    def _send_message(self, message: Mapping[str, Any]) -> None:
        """Writes one message, ended by a NUL byte, to the command pipe."""
        data = memoryview(json.dumps(message).encode("utf-8") + b"\0")
        try:
            while data:
                data = data[os.write(self._command_fd, data) :]
        except BrokenPipeError as error:
            raise PageReadError("Chromium closed its DevTools pipe") from error

    def _read_message(self) -> Mapping[str, Any]:
        """Reads the next message, ended by a NUL byte, from the message pipe.

        Raises:
            PageReadError: The message says the page's renderer crashed, the
                pipe ended, or the message is not a JSON object.
        """
        end = self._unread_bytes.find(b"\0")
        while end == -1:
            searched_count = len(self._unread_bytes)
            chunk = os.read(self._message_fd, READ_CHUNK_BYTE_COUNT)
            if not chunk:
                raise PageReadError("Chromium closed its DevTools pipe")
            self._unread_bytes += chunk
            end = self._unread_bytes.find(b"\0", searched_count)
        data = bytes(self._unread_bytes[:end])
        del self._unread_bytes[: end + 1]
        try:
            message = json.loads(data)
        except ValueError as error:
            raise PageReadError("Chromium sent a message that is not JSON") from error
        if not isinstance(message, dict):
            raise PageReadError("Chromium sent a message that is not an object")
        if message.get("method") == RENDERER_CRASH_EVENT:
            raise PageReadError("The page's renderer crashed")
        return message


def start_chromium() -> ChromiumDevToolsPipe:
    """Starts headless Chromium with a DevTools pipe and no tab.

    Returns:
        The pipe, which owns Chromium from then on.

    Raises:
        OSError: The pipe could not be created or Chromium could not start.
    """
    command_read_fd, command_write_fd = os.pipe()
    message_read_fd, message_write_fd = os.pipe()
    try:
        process = subprocess.Popen(
            CHROMIUM_COMMAND,
            stdin=command_read_fd,
            stdout=message_write_fd,
            stderr=subprocess.DEVNULL,
        )
    except BaseException:
        os.close(command_write_fd)
        os.close(message_read_fd)
        raise
    finally:
        os.close(command_read_fd)
        os.close(message_write_fd)
    return ChromiumDevToolsPipe(process, command_write_fd, message_read_fd)


def open_page_session(browser: ChromiumDevToolsPipe) -> str:
    """Opens a tab on ``about:blank`` and attaches to it.

    Args:
        browser: Chromium, with no tab of the reader's open yet.

    Returns:
        The tab's session id, with its crash, page, and lifecycle events
        enabled.

    Raises:
        PageReadError: Chromium refused a command, or the pipe failed.
    """
    target = browser.send_command("Target.createTarget", {"url": "about:blank"})
    session = browser.send_command(
        "Target.attachToTarget", {"targetId": target["targetId"], "flatten": True}
    )
    session_id = session["sessionId"]
    browser.send_command("Inspector.enable", session_id=session_id)
    browser.send_command("Page.enable", session_id=session_id)
    browser.send_command(
        "Page.setLifecycleEventsEnabled", {"enabled": True}, session_id=session_id
    )
    return session_id


def load_page(browser: ChromiumDevToolsPipe, session_id: str, url: str) -> str:
    """Loads a page in a tab, then runs its timers for the virtual time budget.

    Args:
        browser: Chromium.
        session_id: Session of the tab, from open_page_session.
        url: The page's URL.

    Returns:
        The id of the page's main frame.

    Raises:
        PageReadError: Chromium could not load the page, the URL starts a
            download, Chromium refused a command, the page's renderer
            crashed, or the pipe failed.
    """
    navigation = browser.send_command(
        "Page.navigate", {"url": url}, session_id=session_id
    )
    if navigation.get("errorText") or navigation.get("isDownload"):
        reason = navigation.get("errorText") or "net::ERR_ABORTED (download)"
        raise PageReadError(f"Chromium could not load the page: {reason}")
    frame_id = navigation["frameId"]
    browser.wait_for_event(
        "Page.lifecycleEvent",
        session_id,
        lambda params: (
            params.get("name") == "load" and params.get("frameId") == frame_id
        ),
    )
    browser.send_command(
        "Emulation.setVirtualTimePolicy", VIRTUAL_TIME_POLICY, session_id=session_id
    )
    browser.wait_for_event("Emulation.virtualTimeBudgetExpired", session_id)
    return frame_id


def get_page_script_result(
    browser: ChromiumDevToolsPipe,
    page_script: str,
    *,
    session_id: str,
    frame_id: str,
) -> str:
    """Runs the page script in a new script world of the page's main frame.

    Args:
        browser: Chromium.
        page_script: Source of flatten_dom.js.
        session_id: Session of the tab, from open_page_session.
        frame_id: The page's main frame, from load_page.

    Returns:
        The HTML the script returned.

    Raises:
        PageReadError: The script threw or returned no text, Chromium refused
            a command, the page's renderer crashed, or the pipe failed.
    """
    world = browser.send_command(
        "Page.createIsolatedWorld",
        {"frameId": frame_id, "worldName": PAGE_SCRIPT_WORLD_NAME},
        session_id=session_id,
    )
    evaluation = browser.send_command(
        "Runtime.evaluate",
        {
            "expression": page_script,
            "contextId": world["executionContextId"],
            "returnByValue": True,
        },
        session_id=session_id,
    )
    if "exceptionDetails" in evaluation:
        details = evaluation["exceptionDetails"]
        description = details.get("exception", {}).get("description", details["text"])
        first_line = description.partition("\n")[0]
        raise PageReadError(f"The page script failed: {first_line}")
    html = evaluation["result"].get("value")
    if not isinstance(html, str):
        raise PageReadError("The page script returned no text")
    return html


def get_page_html(url: str) -> str:
    """Reads a page in a Chromium of its own.

    Args:
        url: The page's URL.

    Returns:
        The page's HTML, as flatten_dom.js builds it.

    Raises:
        PageReadError: The page could not be read.
        OSError: flatten_dom.js could not be read, or Chromium could not
            start.
    """
    page_script = PAGE_SCRIPT_PATH.read_text(encoding="utf-8")
    with start_chromium() as browser:
        session_id = open_page_session(browser)
        frame_id = load_page(browser, session_id, url)
        return get_page_script_result(
            browser, page_script, session_id=session_id, frame_id=frame_id
        )


if __name__ == "__main__":
    arguments = sys.argv[1:]
    if len(arguments) != 1:
        raise SystemExit("Usage: python3 dump_dom.py <url>")
    try:
        page_html = get_page_html(arguments[0])
    except PageReadError as error:
        raise SystemExit(f"Error: {error}") from error
    sys.stdout.buffer.write(f"{page_html}\n".encode("utf-8"))
