"""Decides, opens, and counts the connections to the web of one page read.

For each request Chromium sends the reader's proxy, the gate looks up the
target's host name itself, refuses it when any address is blocked by the
backend's address rule, and otherwise connects to one of the addresses it
checked, so a name that resolves differently later is never followed. One
read may open at most MAXIMUM_CONNECTION_COUNT connections and receive at
most MAXIMUM_RECEIVED_BYTE_COUNT bytes; the request that would pass either
stops the gate, which ends every proxied connection.
"""

import errno
import selectors
import socket
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from proxy_http import ProxyTarget
from web_addresses import BlockedAddressRanges, is_blocked_address

# Most connections to the web one read opens, inclusive: one per request
# whose target the rule allows. The next one stops the gate.
MAXIMUM_CONNECTION_COUNT = 256

# Most bytes one read receives from the web, inclusive, counted as they
# arrive from the targets: headers, bodies, and tunneled TLS records alike.
MAXIMUM_RECEIVED_BYTE_COUNT = 64 * 1024 * 1024

# Seconds a connection attempt may take, and the timeout of the sockets the
# gate opens, which bounds each send and receive on them.
SOCKET_TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class HostAddress:
    """One address a target's host name resolves to."""

    family: int
    """Address family, ``socket.AF_INET`` or ``socket.AF_INET6``."""
    socket_address: tuple
    """Address to connect to, as getaddrinfo gives it; its first item is the
    IP address without brackets."""


type HostAddressLookup = Callable[[str, int], Sequence[HostAddress]]
"""Resolves a host name and port to every address, in the resolver's order;
raises OSError when there is none."""


def list_host_addresses(host: str, port: int) -> Sequence[HostAddress]:
    """Resolves a target through the VM's resolver.

    Args:
        host: Host name or IP address, without brackets.
        port: TCP port.

    Returns:
        Every TCP address, in the resolver's order.

    Raises:
        OSError: The name has no address, or the lookup failed.
    """
    return [
        HostAddress(family, socket_address)
        for family, _, _, _, socket_address in socket.getaddrinfo(
            host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
        )
    ]


class StopSignal:
    """Tells every connection of a proxy at once that it must end.

    It is a socket pair whose write end closes when it stops, so a wait on
    sockets also wakes on its read end.

    Lifecycle: open_stop_signal returns it running. stop() stops it for good.
    close() also releases both ends, which no wait may use afterwards.

    Concurrency: thread-safe. Any thread may stop it or wait on it at once;
    close() must come after every wait has returned.
    """

    def __init__(self, reader: socket.socket, writer: socket.socket) -> None:
        """Takes ownership of a connected socket pair.

        Args:
            reader: End whose readability shows the signal stopped.
            writer: End closed to stop the signal.
        """
        self._reader = reader
        """Read end, owned; readable once the signal stopped."""
        self._writer = writer
        """Write end, owned; stop() closes it."""
        self._lock = threading.Lock()
        """Guards _is_stopped and the closing of the write end."""
        self._is_stopped = False
        """Whether stop() or close() has run."""

    @property
    def is_stopped(self) -> bool:
        """Whether the signal stopped.

        Returns:
            True once stop() or close() has run.
        """
        with self._lock:
            return self._is_stopped

    def stop(self) -> None:
        """Stops the signal, which wakes every wait. Stopping again does nothing."""
        with self._lock:
            if self._is_stopped:
                return
            self._is_stopped = True
            self._writer.close()

    def wait_for_ready_sockets(
        self, events: Mapping[socket.socket, int], timeout_seconds: float | None
    ) -> set[socket.socket] | None:
        """Waits until some sockets are ready or the signal stops.

        Args:
            events: The sockets and, for each, the selectors events awaited.
            timeout_seconds: Longest wait; no limit when None.

        Returns:
            The sockets that are ready, empty when the wait timed out; None
            once the signal stopped.
        """
        with selectors.DefaultSelector() as selector:
            selector.register(self._reader, selectors.EVENT_READ)
            for awaited_socket, awaited_events in events.items():
                selector.register(awaited_socket, awaited_events)
            ready_keys = selector.select(timeout_seconds)
        if self.is_stopped:
            return None
        return {key.fileobj for key, _ in ready_keys}

    def close(self) -> None:
        """Stops the signal and releases both ends. Closing again does nothing."""
        self.stop()
        self._reader.close()


def open_stop_signal() -> StopSignal:
    """Opens a running stop signal.

    Returns:
        The signal, which the caller owns and must close.

    Raises:
        OSError: The socket pair could not be created.
    """
    reader, writer = socket.socketpair()
    return StopSignal(reader, writer)


@dataclass(frozen=True)
class ReadUsage:
    """What one read has used of its bounds."""

    connection_count: int
    """Connections opened, from 0 to MAXIMUM_CONNECTION_COUNT."""
    received_byte_count: int
    """Bytes received, from 0 to MAXIMUM_RECEIVED_BYTE_COUNT."""


class ConnectionGate:
    """Decides, opens, and counts every connection to the web of one read.

    Invariant: no connection it opens goes to an address the rule blocks, and
    the usage never passes the bounds: what would pass one stops the gate
    instead.

    Lifecycle: open_connection_gate returns it open. stop() and a passed bound
    stop it for good: every wait returns None and no connection opens. close()
    releases its stop signal once every connection has ended.

    Concurrency: thread-safe. Each connection's thread calls it at once; a
    lock guards the usage and the refused targets.
    """

    def __init__(
        self,
        ranges: BlockedAddressRanges,
        list_addresses: HostAddressLookup,
        stop_signal: StopSignal,
    ) -> None:
        """Takes ownership of a stop signal.

        Args:
            ranges: The blocked ranges.
            list_addresses: Resolves each target's host name.
            stop_signal: Running signal, owned from now on.
        """
        self._ranges = ranges
        """The blocked ranges."""
        self._list_addresses = list_addresses
        """Resolves each target's host name."""
        self._stop_signal = stop_signal
        """Stops when the gate stops, owned; close() releases it."""
        self._lock = threading.Lock()
        """Guards _usage and _refused_targets."""
        self._usage = ReadUsage(connection_count=0, received_byte_count=0)
        """What the read has used of its bounds."""
        self._refused_targets: set[ProxyTarget] = set()
        """Targets the rule refused."""

    def open_connection(self, target: ProxyTarget) -> socket.socket | None:
        """Opens a connection to a target the rule allows.

        Args:
            target: Host and port Chromium asked for.

        Returns:
            A connected blocking socket with SOCKET_TIMEOUT_SECONDS, which the
            caller owns; None when the gate is stopped, the name has no
            address, the rule refuses an address of it, which is recorded,
            the connection would pass MAXIMUM_CONNECTION_COUNT, which stops
            the gate, or no address could be connected to in time.
        """
        if self._stop_signal.is_stopped:
            return None
        try:
            addresses = self._list_addresses(target.host, target.port)
        except OSError:
            return None
        if any(
            is_blocked_address(address.socket_address[0], self._ranges)
            for address in addresses
        ):
            with self._lock:
                self._refused_targets.add(target)
            return None
        if not self._offer_connection():
            return None
        for address in addresses:
            upstream = self._open_socket(address)
            if upstream is not None:
                return upstream
        return None

    def offer_received_bytes(self, byte_count: int) -> bool:
        """Offers bytes received from the web to the received bound.

        Args:
            byte_count: Bytes just received, which the caller has not passed
                on yet.

        Returns:
            True when they fit MAXIMUM_RECEIVED_BYTE_COUNT and may be passed
            on; False when they would pass it, which stops the gate, or the
            gate is stopped.
        """
        with self._lock:
            received_byte_count = self._usage.received_byte_count + byte_count
            is_within_bound = received_byte_count <= MAXIMUM_RECEIVED_BYTE_COUNT
            if is_within_bound:
                self._usage = ReadUsage(
                    self._usage.connection_count, received_byte_count
                )
        if not is_within_bound:
            self.stop()
        return is_within_bound and not self._stop_signal.is_stopped

    def wait_for_readable_sockets(
        self, sockets: Sequence[socket.socket], timeout_seconds: float | None
    ) -> set[socket.socket] | None:
        """Waits until some sockets have bytes or an end to read.

        Args:
            sockets: Sockets of one connection, or the proxy's listener.
            timeout_seconds: Longest wait; no limit when None.

        Returns:
            The readable sockets, empty when the wait timed out; None once
            the gate is stopped.
        """
        events = {waited_socket: selectors.EVENT_READ for waited_socket in sockets}
        return self._stop_signal.wait_for_ready_sockets(events, timeout_seconds)

    def has_refused(self, target: ProxyTarget) -> bool:
        """Answers whether the rule refused a target.

        Args:
            target: Host and port, as find_url_target gives them.

        Returns:
            True when the rule refused a request for that target. A request
            refused because the gate was stopped, the name had no address,
            or a connection failed is not recorded.
        """
        with self._lock:
            return target in self._refused_targets

    def stop(self) -> None:
        """Stops the gate: every wait returns None and no connection opens.

        Stopping again does nothing.
        """
        self._stop_signal.stop()

    def close(self) -> None:
        """Stops the gate and releases its stop signal.

        Call it only once every connection's thread has ended, because they
        wait on the signal. Closing again does nothing.
        """
        self._stop_signal.close()

    def _offer_connection(self) -> bool:
        """Offers one more connection to the connection bound.

        Returns:
            True when it fits MAXIMUM_CONNECTION_COUNT; False when it would
            pass it, which stops the gate.
        """
        with self._lock:
            connection_count = self._usage.connection_count + 1
            is_within_bound = connection_count <= MAXIMUM_CONNECTION_COUNT
            if is_within_bound:
                self._usage = ReadUsage(
                    connection_count, self._usage.received_byte_count
                )
        if not is_within_bound:
            self.stop()
        return is_within_bound

    def _open_socket(self, address: HostAddress) -> socket.socket | None:
        """Connects to one checked address until connected, timed out, or
        stopped.

        Args:
            address: An address the rule allowed.

        Returns:
            The connected blocking socket with SOCKET_TIMEOUT_SECONDS, which
            the caller owns; None when the connection was refused or timed
            out, or the gate stopped first.
        """
        upstream = socket.socket(address.family, socket.SOCK_STREAM)
        try:
            upstream.setblocking(False)
            error_code = upstream.connect_ex(address.socket_address)
            if error_code == errno.EINPROGRESS:
                events = {upstream: selectors.EVENT_WRITE}
                if not self._stop_signal.wait_for_ready_sockets(
                    events, SOCKET_TIMEOUT_SECONDS
                ):
                    upstream.close()
                    return None
                error_code = upstream.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if error_code != 0:
                upstream.close()
                return None
            upstream.settimeout(SOCKET_TIMEOUT_SECONDS)
            return upstream
        except BaseException:
            upstream.close()
            raise


def open_connection_gate(
    ranges: BlockedAddressRanges, list_addresses: HostAddressLookup
) -> ConnectionGate:
    """Opens the gate of one read.

    Args:
        ranges: The blocked ranges.
        list_addresses: Resolves each target's host name.

    Returns:
        An open gate, which the caller owns and must close.

    Raises:
        OSError: Its stop signal could not be created.
    """
    return ConnectionGate(ranges, list_addresses, open_stop_signal())
