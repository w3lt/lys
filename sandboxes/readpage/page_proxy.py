"""The proxy every connection of the reader's Chromium goes through.

Chromium starts with ``--proxy-server`` set to the proxy's URL and no bypass,
loopback included, so the page, every redirect, and everything the page loads
reach the web only through it. Each connection Chromium opens to the proxy
carries one request: a ``CONNECT`` tunnel or one forwarded plain-HTTP
request. A ConnectionGate decides whether the target may be connected to and
bounds the read. A refusal closes Chromium's connection without an answer, so
Chromium fails the request instead of showing a page of the proxy's own, and
the proxy keeps the refused target for has_refused.
"""

import socket
import threading
from dataclasses import dataclass

from connection_gate import (
    ConnectionGate,
    HostAddressLookup,
    list_host_addresses,
    open_connection_gate,
)
from proxy_http import (
    HEAD_TERMINATOR,
    TUNNEL_ESTABLISHED_RESPONSE,
    ForwardedRequest,
    TunnelRequest,
    find_url_target,
    parse_request_head,
    parse_response_head,
)
from web_addresses import BlockedAddressRanges

# Most bytes of a request or response head, its terminator included. A
# longer head ends its connection.
MAXIMUM_HEAD_BYTE_COUNT = 64 * 1024

# Seconds Chromium has to send each part of its request head and body.
REQUEST_TIMEOUT_SECONDS = 10

# Most bytes read from a socket at a time.
READ_CHUNK_BYTE_COUNT = 65_536

# Address the proxy listens on: the VM's own IPv4 loopback.
LISTEN_HOST = "127.0.0.1"


@dataclass(frozen=True)
class MessageHead:
    """A message head read from a socket, and the bytes read after it."""

    head: bytes
    """The head, without HEAD_TERMINATOR."""
    rest: bytes
    """Bytes that arrived after the head in the same reads: the start of the
    body, or of tunneled bytes."""


@dataclass(frozen=True)
class ProxiedConnection:
    """One request's two connections and the gate that bounds them.

    The thread serving the request owns both sockets; the gate is the read's.
    """

    client: socket.socket
    """Chromium's connection to the proxy."""
    upstream: socket.socket
    """The proxy's connection to the request's target."""
    gate: ConnectionGate
    """The gate of the read: it counts the target's bytes, and its stop ends
    every wait."""


class PageProxy:
    """Owns the proxy server of one read: its gate and threads.

    Invariant: while it is open, every connection Chromium makes to it is
    served by a thread of its own, which owns that connection and the one it
    opens to the web.

    Lifecycle: open() returns it listening. A passed bound of its gate makes
    it stop listening; the read goes on with what it loaded. close() stops
    the gate, which ends every connection, joins every thread, and releases
    the gate. From then on it is closed for good; has_refused still answers
    from what it recorded.

    Concurrency: the reader's thread owns it and calls open, url,
    has_refused, and close; its own threads use only its gate, which is
    thread-safe.
    """

    def __init__(
        self,
        listen_port: int,
        gate: ConnectionGate,
        accept_thread: threading.Thread,
        connection_threads: list[threading.Thread],
    ) -> None:
        """Takes ownership of a proxy's gate and threads.

        Args:
            listen_port: TCP port the proxy's listener is bound to.
            gate: The gate of the read, owned from now on.
            accept_thread: Thread, not started yet, that runs
                handle_incoming_connections; the listener is its own.
            connection_threads: The list handle_incoming_connections adds
                each connection's thread to; only the accept thread changes it.
        """
        self._listen_port = listen_port
        """TCP port the proxy listens on."""
        self._gate = gate
        """The gate of the read, owned; close() closes it."""
        self._accept_thread = accept_thread
        """The thread that accepts connections, owned; close() joins it."""
        self._connection_threads = connection_threads
        """Threads of the connections still running, owned; close() joins
        them after the accept thread, once the list no longer changes."""
        self._is_closed = False
        """Whether close() has begun."""

    @classmethod
    def open(
        cls,
        ranges: BlockedAddressRanges,
        list_addresses: HostAddressLookup = list_host_addresses,
    ) -> "PageProxy":
        """Starts a proxy for one read on a free port of LISTEN_HOST.

        Args:
            ranges: The blocked ranges.
            list_addresses: Resolves each target's host name; the VM's
                resolver when omitted.

        Returns:
            The listening proxy, which the caller owns and must close.

        Raises:
            OSError: The proxy could not listen. Nothing is left open.
            RuntimeError: Its accept thread could not start. Nothing is left
                open.
        """
        gate = open_connection_gate(ranges, list_addresses)
        try:
            listener = socket.create_server((LISTEN_HOST, 0))
        except BaseException:
            gate.close()
            raise
        connection_threads: list[threading.Thread] = []
        accept_thread = threading.Thread(
            target=handle_incoming_connections,
            args=(listener, gate, connection_threads),
            name="page-proxy-accept",
            daemon=True,
        )
        try:
            listener.setblocking(False)
            listen_port = listener.getsockname()[1]
            proxy = cls(listen_port, gate, accept_thread, connection_threads)
            accept_thread.start()
        except BaseException:
            listener.close()
            gate.close()
            raise
        return proxy

    @property
    def url(self) -> str:
        """The URL Chromium's ``--proxy-server`` takes.

        Returns:
            ``http://127.0.0.1:<port>``.
        """
        return f"http://{LISTEN_HOST}:{self._listen_port}"

    def __enter__(self) -> "PageProxy":
        """Begins a with block that closes this proxy at its end.

        Returns:
            This proxy, still open.
        """
        return self

    def __exit__(self, *exception_info: object) -> None:
        """Closes this proxy at the end of a with block.

        Args:
            exception_info: The type, value, and traceback of the exception
                the block raised; all None when it raised none.
        """
        self.close()

    def has_refused(self, url: str) -> bool:
        """Answers whether the address rule refused the host and port of a URL.

        Args:
            url: Untrusted URL, such as the one Chromium's main frame could
                not load.

        Returns:
            True when the proxy refused a request for that host and port
            because an address of the host is blocked.
        """
        target = find_url_target(url)
        return target is not None and self._gate.has_refused(target)

    def close(self) -> None:
        """Ends every connection, waits for every thread, and releases the gate.

        A connection's thread ends at once, except one resolving a host name,
        which first waits for the VM's resolver to answer or give up, and one
        sending to a target that reads nothing, which gives up after the
        gate's SOCKET_TIMEOUT_SECONDS. Closing again does nothing.
        """
        if self._is_closed:
            return
        self._is_closed = True
        self._gate.stop()
        self._accept_thread.join()
        for connection_thread in self._connection_threads:
            connection_thread.join()
        self._gate.close()


def handle_incoming_connections(
    listener: socket.socket,
    gate: ConnectionGate,
    connection_threads: list[threading.Thread],
) -> None:
    """Accepts Chromium's connections until the gate stops.

    Each connection is served by handle_incoming_request in a thread of its
    own. When the gate stops, the listener closes, so Chromium's later
    connections are refused at once instead of waiting.

    Args:
        listener: Non-blocking listening socket, owned; closed on return.
        gate: The gate of the read.
        connection_threads: Threads of the connections; finished ones are
            dropped from it, and each new one is added once it has started.

    Raises:
        RuntimeError: A connection's thread could not start; that connection
            is closed.
    """
    with listener:
        while gate.wait_for_readable_sockets([listener], None) is not None:
            try:
                client, _ = listener.accept()
            except (BlockingIOError, ConnectionAbortedError):
                continue
            thread = threading.Thread(
                target=handle_incoming_request, args=(client, gate), daemon=True
            )
            try:
                thread.start()
            except BaseException:
                client.close()
                raise
            connection_threads[:] = [
                running for running in connection_threads if running.is_alive()
            ]
            connection_threads.append(thread)


def handle_incoming_request(client: socket.socket, gate: ConnectionGate) -> None:
    """Serves the one request of a connection Chromium made to the proxy.

    A request the proxy refuses, a target the gate does not open, a stopped
    gate, and a failed send or receive all end the connection without an
    answer.

    Args:
        client: Accepted connection, owned; closed on return.
        gate: The gate of the read.
    """
    with client:
        try:
            client.settimeout(REQUEST_TIMEOUT_SECONDS)
            request_head = read_head(client, gate, REQUEST_TIMEOUT_SECONDS)
            request = (
                None if request_head is None else parse_request_head(request_head.head)
            )
            upstream = None if request is None else gate.open_connection(request.target)
            if upstream is None:
                return
            with upstream:
                connection = ProxiedConnection(client, upstream, gate)
                if isinstance(request, TunnelRequest):
                    client.sendall(TUNNEL_ESTABLISHED_RESPONSE)
                    upstream.sendall(request_head.rest)
                    follow_target_bytes(connection, is_tunnel=True)
                else:
                    send_forwarded_request(connection, request, request_head.rest)
        except OSError:
            # A connection that fails, times out, or is reset ends like a
            # refused one: closed, and Chromium fails the request.
            return


def send_forwarded_request(
    connection: ProxiedConnection, request: ForwardedRequest, received_body: bytes
) -> None:
    """Sends one plain-HTTP request to its target and its response to Chromium.

    Args:
        connection: The request's connections.
        request: The request, in origin form.
        received_body: Bytes Chromium sent after the request head.

    Raises:
        OSError: A send or receive failed.
    """
    connection.upstream.sendall(request.head)
    if not send_request_body(connection, request, received_body):
        return
    response_head = read_head(
        connection.upstream, connection.gate, None, peer=connection.client
    )
    passed_head = (
        None if response_head is None else parse_response_head(response_head.head)
    )
    if passed_head is None:
        return
    connection.client.sendall(passed_head + response_head.rest)
    follow_target_bytes(connection, is_tunnel=False)


def send_request_body(
    connection: ProxiedConnection, request: ForwardedRequest, received_body: bytes
) -> bool:
    """Sends a forwarded request's body from Chromium to the target.

    Args:
        connection: The request's connections.
        request: The request, whose body_byte_count bounds what is sent.
        received_body: Bytes Chromium sent after the request head; bytes past
            the body are not passed on.

    Returns:
        True once the whole body was sent; False when Chromium closed the
        connection or took longer than REQUEST_TIMEOUT_SECONDS, or the gate
        stopped.

    Raises:
        OSError: A send or receive failed.
    """
    remaining_byte_count = request.body_byte_count
    chunk = received_body[:remaining_byte_count]
    while True:
        connection.upstream.sendall(chunk)
        remaining_byte_count -= len(chunk)
        if remaining_byte_count == 0:
            return True
        chunk = read_chunk(connection.client, connection.gate, REQUEST_TIMEOUT_SECONDS)
        if chunk is None:
            return False
        chunk = chunk[:remaining_byte_count]


def follow_target_bytes(connection: ProxiedConnection, *, is_tunnel: bool) -> None:
    """Passes the target's bytes to Chromium until either side ends.

    Each chunk from the target is offered to the gate's received bound before
    it is passed on. A tunnel also passes Chromium's bytes to the target; a
    forwarded request has sent its one request, so any byte from Chromium, or
    its close, ends it.

    Args:
        connection: The request's connections; the gate's stop ends it.
        is_tunnel: Whether the connection is a CONNECT tunnel.

    Raises:
        OSError: A send or receive failed.
    """
    client, upstream, gate = connection.client, connection.upstream, connection.gate
    while (
        ready := gate.wait_for_readable_sockets([client, upstream], None)
    ) is not None:
        if upstream in ready:
            chunk = upstream.recv(READ_CHUNK_BYTE_COUNT)
            if not chunk or not gate.offer_received_bytes(len(chunk)):
                return
            client.sendall(chunk)
        if client in ready:
            chunk = client.recv(READ_CHUNK_BYTE_COUNT)
            if not chunk or not is_tunnel:
                return
            upstream.sendall(chunk)


def read_head(
    source: socket.socket,
    gate: ConnectionGate,
    timeout_seconds: float | None,
    *,
    peer: socket.socket | None = None,
) -> MessageHead | None:
    """Reads a message head of at most MAXIMUM_HEAD_BYTE_COUNT bytes.

    Args:
        source: Chromium's connection, for a request head, or the target's,
            for a response head.
        gate: The gate of the read.
        timeout_seconds: Longest wait for each chunk; no limit when None.
        peer: Chromium's connection while a response head is read, as for
            read_chunk.

    Returns:
        The head and the bytes after it; None when the head is longer than
        the bound, or read_chunk ended the read first.

    Raises:
        OSError: A receive failed.
    """
    received = bytearray()
    while (end := received.find(HEAD_TERMINATOR)) == -1:
        if len(received) >= MAXIMUM_HEAD_BYTE_COUNT:
            return None
        chunk = read_chunk(source, gate, timeout_seconds, peer=peer)
        if chunk is None:
            return None
        received += chunk
    rest_start = end + len(HEAD_TERMINATOR)
    if rest_start > MAXIMUM_HEAD_BYTE_COUNT:
        return None
    return MessageHead(bytes(received[:end]), bytes(received[rest_start:]))


def read_chunk(
    source: socket.socket,
    gate: ConnectionGate,
    timeout_seconds: float | None,
    *,
    peer: socket.socket | None = None,
) -> bytes | None:
    """Reads the next bytes from a socket.

    Args:
        source: Socket to read from: Chromium's connection, or the target's
            when a peer is given, whose bytes are offered to the gate's
            received bound.
        gate: The gate of the read.
        timeout_seconds: Longest wait; no limit when None.
        peer: Chromium's connection while a response is awaited; any byte
            from it, or its close, ends the wait, because its one request
            was sent.

    Returns:
        Up to READ_CHUNK_BYTE_COUNT bytes; None when the source closed, the
        wait timed out, the peer became readable, the gate stopped, or the
        bytes would pass the gate's received bound.

    Raises:
        OSError: The receive failed.
    """
    watched = [source] if peer is None else [source, peer]
    ready = gate.wait_for_readable_sockets(watched, timeout_seconds)
    if not ready or peer in ready:
        return None
    chunk = source.recv(READ_CHUNK_BYTE_COUNT)
    is_within_bound = peer is None or gate.offer_received_bytes(len(chunk))
    return chunk if chunk and is_within_bound else None
