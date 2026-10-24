"""Writes the HTML of a page as headless Chromium renders it.

The reader's entrypoint runs ``python3 dump_dom.py <url>`` and pipes standard
output to parse_dom.py. The page is loaded with the steps Chromium's own
``--dump-dom --virtual-time-budget=10000`` takes: a new tab opens on
``about:blank`` and navigates to the URL; once the main frame has fired
``load``, the page's timers run for 10 seconds of virtual time, which pauses
while a network fetch is pending. A dialog the page opens, such as an
``alert()``, is dismissed, so the page goes on. flatten_dom.js then builds the
HTML in a script world of the reader's own, with the page's open shadow roots
flattened, where ``--dump-dom`` would write ``document.documentElement``'s
``outerHTML``.

Every connection Chromium makes goes through a PageProxy of the reader's
own, which applies the backend's address rule and the read's bounds to it,
so a redirect or a request of the page to a blocked address is never
connected to.

It exits with 0 after writing the HTML and a newline as UTF-8. It exits with
the ``blockedAddress`` code of page_reader_exit_codes.json and
``Error: <reason>`` on standard error, having written nothing, when the page
or a page it redirected to is at an address the rule blocks. It exits with 1
and ``Error: <reason>`` on standard error, having written nothing, when
Chromium cannot load the page for any other reason, the URL starts a
download, Chromium refuses a DevTools command, sends a message that is not a
JSON object or lacks a field the reader reads, the page's renderer crashes,
Chromium closes its DevTools pipe, as it does when it cannot start, or the
page script fails. Chromium's own messages are discarded. Any other failure,
such as flatten_dom.js being missing, ends it with a Python traceback and
exit code 1.
"""

import json
import os
import subprocess
import sys
from collections.abc import Callable, Mapping
from pathlib import Path

from page_proxy import PageProxy
from web_addresses import BLOCKED_ADDRESS_RANGES_PATH, load_blocked_address_ranges

# The shell moves the DevTools pipe to the descriptors Chromium's
# --remote-debugging-pipe reads and writes, 3 and 4, and puts Chromium's
# standard input and output on /dev/null. --disable-lazy-loading is the
# switch headless Chromium adds for --dump-dom, so images and frames below
# the viewport load too. start_chromium adds --proxy-server. The other
# switches keep every connection on that proxy: <-loopback> removes the
# implicit bypass of loopback addresses, and WebRTC's UDP and QUIC, which an
# HTTP proxy cannot carry, are off, so neither leaves beside the proxy.
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
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-quic",
)

# Virtual time policy set once the main frame has fired load, as
# --virtual-time-budget=10000 sets it: the page's timers run for 10,000
# milliseconds of virtual time, which stands still while a network fetch is
# pending, and Chromium moves virtual time forward after 9,999 tasks run
# without it moving, so a page that keeps posting tasks cannot hold it back.
VIRTUAL_TIME_POLICY: Mapping[str, object] = {
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

# The backend's exit codes of the reader, which the image copies next to this
# file from apps/backend/src/modules/tool/builtIn/web.
EXIT_CODES_PATH = Path(__file__).with_name("page_reader_exit_codes.json")

# Event Chromium sends when the renderer of a tab crashes. It answers no
# command to that tab afterwards, so the read cannot go on.
RENDERER_CRASH_EVENT = "Inspector.targetCrashed"

# Event Chromium sends once a DevTools client has enabled the Page domain and
# the page opens a dialog: an alert, a confirm or prompt box, or a page-leave
# prompt. The page's script, and with it its virtual time, then waits until a
# client answers the dialog; headless Chromium answers none itself.
DIALOG_OPENING_EVENT = "Page.javascriptDialogOpening"

# Command that answers a dialog. The reader dismisses each one, as a person
# pressing Cancel would.
DIALOG_ANSWER_COMMAND = "Page.handleJavaScriptDialog"


class PageReadError(Exception):
    """Failure that keeps the reader from reading the page; the message says why.

    It stands for a page Chromium cannot load, a URL that starts a download, a
    DevTools command Chromium refuses, including a dialog dismissal, a message
    from Chromium that is not a JSON object or lacks a field the reader reads, a
    renderer crash, a DevTools pipe Chromium closes, as it does when it cannot
    start, and a page script that fails or returns no text; its subclass
    BlockedAddressError stands for a page at a blocked address. The entrypoint
    writes its message as ``Error: <message>``. An OSError, such as a pipe that
    cannot be created or a page script file that cannot be read, and a
    programming error, such as using a closed ChromiumDevToolsPipe, are never
    represented by this class. It keeps the failure it translates, if any, as
    its ``__cause__``. It owns no state beyond its message and cause, so any
    thread may raise or read an occurrence.
    """


class BlockedAddressError(PageReadError):
    """The page, or a page it redirected to, is at an address the rule blocks.

    The page's main frame ended on Chromium's error page for a URL whose host
    and port the reader's proxy refused. The entrypoint exits with the
    ``blockedAddress`` code of page_reader_exit_codes.json, which the backend
    reports as ``blocked-address``. Like PageReadError, it owns no state beyond
    its message.
    """

    def __init__(self, refused_url: str) -> None:
        """Creates the error for one URL the main frame could not load.

        Args:
            refused_url: The URL, whose host and port the proxy refused.
        """
        super().__init__(
            f"Chromium did not connect to {refused_url}: its address is blocked"
        )


class ChromiumDevToolsPipe:
    """Owns Chromium and its DevTools pipe, to send it commands and await its events.

    Messages are read only while a command's response or an event is awaited.
    Any other message read meanwhile is dropped, as Chromium's own command
    handler drops the events it has no listener for, with three exceptions. A
    crash of the page's renderer ends any wait. A dialog the page opens is
    dismissed, so the page goes on, and Chromium's answer to the dismissal is
    checked when it is read: a refusal ends the wait in progress.

    Invariant: while it is open, it alone owns Chromium and both pipe ends, and
    each command it sends has an id no earlier command of this pipe had.

    Lifecycle: start_chromium returns it open. close() closes the pipe, which
    ends Chromium, and waits for Chromium to exit, killing it if it does not.
    From then on it is closed for good, even when a release failed, and
    send_command and wait_for_event raise ValueError. If the reader dies
    instead, its pipe closes with it, and Chromium exits too.

    Concurrency: single-owner. One thread uses an instance at a time; nothing
    synchronizes its methods, which share the pipe and the unread bytes.
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
        """Chromium, owned; close() waits for it to exit, or kills it."""
        self._command_fd = command_fd
        """Write end of Chromium's command pipe, owned; close() closes it."""
        self._message_fd = message_fd
        """Read end of Chromium's message pipe, owned; close() closes it."""
        self._unread_bytes = bytearray()
        """Bytes read from the message pipe that begin a message not yet read."""
        self._last_command_id = 0
        """Id of the last command sent; 0 before the first."""
        self._dismissal_ids: set[int] = set()
        """Ids of the dialog dismissals Chromium has not answered yet."""
        self._is_closed = False
        """Whether close() has begun; the pipe is never used again once it has."""

    def __enter__(self) -> "ChromiumDevToolsPipe":
        """Begins a with block that closes this pipe at its end.

        Returns:
            This pipe, still open.
        """
        return self

    def __exit__(self, *exception_info: object) -> None:
        """Closes this pipe at the end of a with block.

        An exception the block raised propagates. When close() fails too, its
        failure propagates instead, with the block's as its ``__context__``.

        Args:
            exception_info: The type, value, and traceback of the exception
                the block raised; all None when it raised none.

        Raises:
            OSError: A pipe end could not be closed.
        """
        self.close()

    def send_command(
        self,
        method: str,
        params: Mapping[str, object] | None = None,
        *,
        session_id: str | None = None,
    ) -> Mapping[str, object]:
        """Sends a DevTools command and waits for its response.

        Args:
            method: The command, such as ``Page.navigate``.
            params: The command's parameters; none when omitted.
            session_id: Session of the tab the command is for; the browser's
                own when omitted.

        Returns:
            The command's result, a JSON object whose fields are not checked.

        Raises:
            PageReadError: Chromium refused the command or answered it without
                a result object, or before answering, the page's renderer
                crashed, Chromium refused a dialog dismissal, closed its
                DevTools pipe, or sent a message that is not a JSON object.
            ValueError: The pipe is closed.
        """
        command_id = self._send_command_message(method, params, session_id=session_id)
        while True:
            message = self._read_message()
            if message.get("id") != command_id:
                continue
            if "error" in message:
                error = json.dumps(message["error"])
                raise PageReadError(f"Chromium refused {method}: {error}")
            return get_devtools_field(
                message, "result", dict, context=f"answer to {method}"
            )

    def wait_for_event(
        self,
        method: str,
        session_id: str,
        is_awaited_event: Callable[[Mapping[str, object]], bool] = lambda _: True,
    ) -> Mapping[str, object]:
        """Waits for a tab's DevTools event.

        Args:
            method: The event, such as ``Page.lifecycleEvent``.
            session_id: Session of the tab the event comes from.
            is_awaited_event: Answers whether an event of that kind, given its
                parameters, is the one awaited; any is when omitted.

        Returns:
            The awaited event's parameters, a JSON object whose fields are not
            checked.

        Raises:
            PageReadError: An event of that kind came without a parameters
                object, or before the awaited event, the page's renderer
                crashed, Chromium refused a dialog dismissal, closed its
                DevTools pipe, or sent a message that is not a JSON object.
            ValueError: The pipe is closed.
        """
        while True:
            message = self._read_message()
            if message.get("method") != method:
                continue
            if message.get("sessionId") != session_id:
                continue
            params = get_devtools_field(message, "params", dict, context=method)
            if is_awaited_event(params):
                return params

    def close(self) -> None:
        """Closes the pipe and waits for Chromium to exit.

        Chromium exits once its command pipe is closed; it is killed when it
        has not exited after CHROMIUM_EXIT_TIMEOUT_SECONDS. Each release is
        attempted even when an earlier one fails, and the pipe is closed for
        good either way. Closing again does nothing, so no descriptor is
        closed twice.

        Raises:
            OSError: A pipe end could not be closed; Chromium has exited or
                been killed all the same. When both fail, the second is
                raised, with the first as its ``__context__``.
        """
        if self._is_closed:
            return
        self._is_closed = True
        try:
            close_descriptors(self._command_fd, self._message_fd)
        finally:
            try:
                self._process.wait(timeout=CHROMIUM_EXIT_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()

    def _send_command_message(
        self,
        method: str,
        params: Mapping[str, object] | None,
        *,
        session_id: str | None,
    ) -> int:
        """Writes a command, ended by a NUL byte, to the command pipe.

        Args:
            method: The command.
            params: The command's parameters; none when None.
            session_id: Session of the tab the command is for; the browser's
                own when None.

        Returns:
            The command's id, which Chromium's answer to it carries.

        Raises:
            PageReadError: Chromium closed its DevTools pipe.
            ValueError: The pipe is closed.
        """
        if self._is_closed:
            raise ValueError("The DevTools pipe is closed")
        self._last_command_id += 1
        command: dict[str, object] = {
            "id": self._last_command_id,
            "method": method,
            "params": params or {},
        }
        if session_id is not None:
            command["sessionId"] = session_id
        data = memoryview(json.dumps(command).encode("utf-8") + b"\0")
        try:
            while data:
                data = data[os.write(self._command_fd, data) :]
        except BrokenPipeError as error:
            raise PageReadError("Chromium closed its DevTools pipe") from error
        return self._last_command_id

    def _read_message(self) -> Mapping[str, object]:
        """Reads the next message a wait can use from the message pipe.

        A dialog the page opens is dismissed, and Chromium's answer to a
        dismissal is checked; neither message is returned.

        Returns:
            The message, a JSON object whose fields are not checked.

        Raises:
            PageReadError: The page's renderer crashed, Chromium refused a
                dialog dismissal, closed its DevTools pipe, or sent a message
                that is not a JSON object or a dialog event without a session.
            ValueError: The pipe is closed.
        """
        while True:
            message = self._read_pipe_message()
            method = message.get("method")
            command_id = message.get("id")
            if method == RENDERER_CRASH_EVENT:
                raise PageReadError("The page's renderer crashed")
            if method == DIALOG_OPENING_EVENT:
                self._handle_dialog_opening(message)
            elif isinstance(command_id, int) and command_id in self._dismissal_ids:
                self._dismissal_ids.remove(command_id)
                if "error" in message:
                    error = json.dumps(message["error"])
                    raise PageReadError(
                        f"Chromium refused {DIALOG_ANSWER_COMMAND}: {error}"
                    )
            else:
                return message

    def _read_pipe_message(self) -> Mapping[str, object]:
        """Reads the next message, ended by a NUL byte, from the message pipe.

        Returns:
            The message, a JSON object whose fields are not checked.

        Raises:
            PageReadError: Chromium closed its DevTools pipe, or the message is
                not a JSON object.
            ValueError: The pipe is closed.
        """
        if self._is_closed:
            raise ValueError("The DevTools pipe is closed")
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
        return message

    def _handle_dialog_opening(self, event: Mapping[str, object]) -> None:
        """Dismisses a dialog the page opened, as Cancel would, so it goes on.

        An alert closes, ``confirm()`` returns false, ``prompt()`` returns
        null, and a page-leave prompt keeps the page. The answer is not
        awaited: _read_message checks it when it arrives.

        Args:
            event: The DIALOG_OPENING_EVENT message.

        Raises:
            PageReadError: The event has no session, or Chromium closed its
                DevTools pipe.
        """
        session_id = get_devtools_field(
            event, "sessionId", str, context=DIALOG_OPENING_EVENT
        )
        command_id = self._send_command_message(
            DIALOG_ANSWER_COMMAND, {"accept": False}, session_id=session_id
        )
        self._dismissal_ids.add(command_id)


def get_devtools_field[FieldType](
    devtools_object: Mapping[str, object],
    name: str,
    field_type: type[FieldType],
    *,
    context: str,
) -> FieldType:
    """Gets a field Chromium must send, checked to be of the type the reader uses.

    Args:
        devtools_object: A JSON object Chromium sent: a message, a command's
            result, an event's parameters, or an object inside one of them.
        name: The field's name.
        field_type: The type the reader uses the field as, such as str.
        context: What Chromium sent, for the error message, such as
            ``answer to Page.navigate``.

    Returns:
        The field's value.

    Raises:
        PageReadError: The field is missing or not a field_type.
    """
    value = devtools_object.get(name)
    if not isinstance(value, field_type):
        raise PageReadError(f"Chromium's {context} has no valid {name}")
    return value


def find_devtools_field[FieldType](
    devtools_object: Mapping[str, object],
    name: str,
    field_type: type[FieldType],
    *,
    context: str,
) -> FieldType | None:
    """Finds a field Chromium may leave out, checked as get_devtools_field does.

    Args:
        devtools_object: A JSON object Chromium sent, as for get_devtools_field.
        name: The field's name.
        field_type: The type the reader uses the field as, such as str.
        context: What Chromium sent, for the error message.

    Returns:
        The field's value; None when Chromium left it out.

    Raises:
        PageReadError: The field is there but not a field_type.
    """
    if name not in devtools_object:
        return None
    return get_devtools_field(devtools_object, name, field_type, context=context)


def close_descriptors(*descriptors: int) -> None:
    """Closes file descriptors, attempting each even when an earlier one fails.

    Args:
        descriptors: Open descriptors the caller owns. None may be used or
            closed again afterwards, even one whose close failed, because its
            number may already name another file.

    Raises:
        OSError: A close failed. When several fail, the last is raised, and
            each earlier failure is the ``__context__`` of the next.
    """
    if not descriptors:
        return
    first_descriptor, *other_descriptors = descriptors
    try:
        os.close(first_descriptor)
    finally:
        close_descriptors(*other_descriptors)


def start_chromium(proxy_url: str) -> ChromiumDevToolsPipe:
    """Starts headless Chromium with a DevTools pipe and no tab.

    Chromium runs through ``sh``, so a Chromium that cannot start, for example
    one missing from PATH, is not found here: its pipe closes, and the first
    command raises PageReadError.

    Args:
        proxy_url: URL of the proxy every connection of Chromium goes through,
            as PageProxy.url gives it.

    Returns:
        The pipe, which owns Chromium from then on.

    Raises:
        OSError: A pipe could not be created, ``sh`` could not start, or a
            descriptor could not be closed. Every descriptor created before
            is closed, and a started Chromium ended, first.
    """
    command_read_fd, command_write_fd = os.pipe()
    try:
        message_read_fd, message_write_fd = os.pipe()
    except BaseException:
        close_descriptors(command_read_fd, command_write_fd)
        raise
    try:
        process = subprocess.Popen(
            (*CHROMIUM_COMMAND, f"--proxy-server={proxy_url}"),
            stdin=command_read_fd,
            stdout=message_write_fd,
            stderr=subprocess.DEVNULL,
        )
    except BaseException:
        close_descriptors(
            command_read_fd, message_write_fd, command_write_fd, message_read_fd
        )
        raise
    browser = ChromiumDevToolsPipe(process, command_write_fd, message_read_fd)
    try:
        close_descriptors(command_read_fd, message_write_fd)
    except BaseException:
        browser.close()
        raise
    return browser


def open_page_session(browser: ChromiumDevToolsPipe) -> str:
    """Opens a tab on ``about:blank`` and attaches to it.

    Args:
        browser: Chromium, with no tab of the reader's open yet.

    Returns:
        The tab's session id, with its crash, page, and lifecycle events
        enabled.

    Raises:
        PageReadError: Chromium refused a command or answered one without a
            field the reader reads, or the pipe failed.
    """
    target = browser.send_command("Target.createTarget", {"url": "about:blank"})
    target_id = get_devtools_field(
        target, "targetId", str, context="answer to Target.createTarget"
    )
    session = browser.send_command(
        "Target.attachToTarget", {"targetId": target_id, "flatten": True}
    )
    session_id = get_devtools_field(
        session, "sessionId", str, context="answer to Target.attachToTarget"
    )
    browser.send_command("Inspector.enable", session_id=session_id)
    browser.send_command("Page.enable", session_id=session_id)
    browser.send_command(
        "Page.setLifecycleEventsEnabled", {"enabled": True}, session_id=session_id
    )
    return session_id


def load_page(
    browser: ChromiumDevToolsPipe, session_id: str, url: str, *, proxy: PageProxy
) -> str:
    """Loads a page in a tab, then runs its timers for the virtual time budget.

    Args:
        browser: Chromium.
        session_id: Session of the tab, from open_page_session.
        url: The page's URL.
        proxy: The proxy Chromium connects through, which knows what it
            refused.

    Returns:
        The id of the page's main frame.

    Raises:
        BlockedAddressError: The page, a page it redirected to, or a page its
            ``<meta>`` refresh or scripts moved the main frame to, is at an
            address the rule blocks.
        PageReadError: Chromium could not load the page for another reason,
            the URL starts a download, Chromium refused a command or answered
            one without a field the reader reads, the page's renderer
            crashed, or the pipe failed.
    """
    navigation = browser.send_command(
        "Page.navigate", {"url": url}, session_id=session_id
    )
    context = "answer to Page.navigate"
    error_text = find_devtools_field(navigation, "errorText", str, context=context)
    is_download = find_devtools_field(navigation, "isDownload", bool, context=context)
    if error_text:
        refused_url = find_refused_main_frame_url(browser, session_id, proxy)
        if refused_url is not None:
            raise BlockedAddressError(refused_url)
    if error_text or is_download:
        reason = error_text or "net::ERR_ABORTED (download)"
        raise PageReadError(f"Chromium could not load the page: {reason}")
    frame_id = get_devtools_field(navigation, "frameId", str, context=context)
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
    refused_url = find_refused_main_frame_url(browser, session_id, proxy)
    if refused_url is not None:
        raise BlockedAddressError(refused_url)
    return frame_id


def find_refused_main_frame_url(
    browser: ChromiumDevToolsPipe, session_id: str, proxy: PageProxy
) -> str | None:
    """Finds the URL the main frame could not load because the proxy refused it.

    A navigation the proxy refused ends on Chromium's error page, whose frame
    keeps the URL it could not load as ``unreachableUrl``: the last redirect's
    target for an HTTP redirect, and the new URL for a ``<meta>`` refresh or
    a script's navigation.

    Args:
        browser: Chromium.
        session_id: Session of the tab, from open_page_session.
        proxy: The proxy Chromium connects through.

    Returns:
        The main frame's ``unreachableUrl`` when the proxy refused its host
        and port by the address rule; None when the frame shows a page, or
        could not load a URL for another reason.

    Raises:
        PageReadError: Chromium refused Page.getFrameTree or answered it
            without a field the reader reads, the page's renderer crashed, or
            the pipe failed.
    """
    tree = browser.send_command("Page.getFrameTree", session_id=session_id)
    context = "answer to Page.getFrameTree"
    frame_tree = get_devtools_field(tree, "frameTree", dict, context=context)
    frame = get_devtools_field(frame_tree, "frame", dict, context=context)
    unreachable_url = find_devtools_field(frame, "unreachableUrl", str, context=context)
    if unreachable_url is None or not proxy.has_refused(unreachable_url):
        return None
    return unreachable_url


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
            a command or answered one without a field the reader reads, the
            page's renderer crashed, or the pipe failed.
    """
    world = browser.send_command(
        "Page.createIsolatedWorld",
        {"frameId": frame_id, "worldName": PAGE_SCRIPT_WORLD_NAME},
        session_id=session_id,
    )
    context_id = get_devtools_field(
        world, "executionContextId", int, context="answer to Page.createIsolatedWorld"
    )
    evaluation = browser.send_command(
        "Runtime.evaluate",
        {"expression": page_script, "contextId": context_id, "returnByValue": True},
        session_id=session_id,
    )
    context = "answer to Runtime.evaluate"
    exception_details = find_devtools_field(
        evaluation, "exceptionDetails", dict, context=context
    )
    if exception_details is not None:
        reason = format_page_script_failure(exception_details)
        raise PageReadError(f"The page script failed: {reason}")
    result = get_devtools_field(evaluation, "result", dict, context=context)
    html = result.get("value")
    if not isinstance(html, str):
        raise PageReadError("The page script returned no text")
    return html


def format_page_script_failure(exception_details: Mapping[str, object]) -> str:
    """Formats why the page script failed, from Chromium's account of it.

    Args:
        exception_details: The ``exceptionDetails`` of Chromium's answer to
            ``Runtime.evaluate``.

    Returns:
        The first line of the exception's description, such as
        ``TypeError: x is not a function``; Chromium's own summary of the
        failure when the exception has no description.

    Raises:
        PageReadError: The details have no summary when one is needed, or an
            exception or description that is not of its JSON type.
    """
    context = "answer to Runtime.evaluate"
    exception = find_devtools_field(
        exception_details, "exception", dict, context=context
    )
    description = (
        None
        if exception is None
        else find_devtools_field(exception, "description", str, context=context)
    )
    if description is None:
        description = get_devtools_field(
            exception_details, "text", str, context=context
        )
    return description.partition("\n")[0]


def get_page_html(url: str) -> str:
    """Reads a page in a Chromium of its own.

    Args:
        url: The page's URL.

    Returns:
        The page's HTML, as flatten_dom.js builds it.

    Raises:
        BlockedAddressError: The page, or a page it led to, is at a blocked
            address.
        PageReadError: The page could not be read for another reason,
            including when Chromium could not start.
        OSError: flatten_dom.js or the ranges file could not be read, the
            proxy could not listen, a pipe could not be created or closed, or
            ``sh`` could not start.
        ValueError: The ranges file does not hold valid ranges.
        RuntimeError: The proxy's thread could not start.
    """
    page_script = PAGE_SCRIPT_PATH.read_text(encoding="utf-8")
    ranges = load_blocked_address_ranges(BLOCKED_ADDRESS_RANGES_PATH)
    with PageProxy.open(ranges) as proxy, start_chromium(proxy.url) as browser:
        session_id = open_page_session(browser)
        frame_id = load_page(browser, session_id, url, proxy=proxy)
        return get_page_script_result(
            browser, page_script, session_id=session_id, frame_id=frame_id
        )


def load_blocked_address_exit_code(path: Path) -> int:
    """Reads the exit code the backend reports as ``blocked-address``.

    Args:
        path: The backend's page_reader_exit_codes.json: a UTF-8 JSON object
            whose only field, ``blockedAddress``, is an exit status from 1 to
            255.

    Returns:
        The exit code.

    Raises:
        OSError: The file could not be read.
        ValueError: The file is not that JSON object.
    """
    exit_codes = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(exit_codes, dict) or set(exit_codes) != {"blockedAddress"}:
        raise ValueError(f"{path} does not hold exactly blockedAddress")
    exit_code = exit_codes["blockedAddress"]
    if type(exit_code) is not int or not 1 <= exit_code <= 255:
        raise ValueError(f"{path} holds no exit status as blockedAddress")
    return exit_code


if __name__ == "__main__":
    arguments = sys.argv[1:]
    if len(arguments) != 1:
        raise SystemExit("Usage: python3 dump_dom.py <url>")
    blocked_address_exit_code = load_blocked_address_exit_code(EXIT_CODES_PATH)
    try:
        page_html = get_page_html(arguments[0])
    except BlockedAddressError as error:
        sys.stderr.write(f"Error: {error}\n")
        raise SystemExit(blocked_address_exit_code) from error
    except PageReadError as error:
        raise SystemExit(f"Error: {error}") from error
    sys.stdout.buffer.write(f"{page_html}\n".encode("utf-8"))
