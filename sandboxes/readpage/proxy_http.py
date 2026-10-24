"""Reads and rewrites the HTTP/1.1 messages the reader's proxy passes on.

Chromium, told to use the proxy for every request, sends it two kinds of
request: ``CONNECT host:port``, for HTTPS and WebSocket connections, which the
proxy tunnels, and an absolute-form request such as
``GET http://host/path HTTP/1.1``, for plain HTTP, which the proxy forwards in
origin form. Each forwarded request goes on a connection of its own:
hop-by-hop headers are dropped and ``Connection: close`` is added, to the
request and to the response head, so neither side reuses the connection for
another request whose target the proxy has not checked.
"""

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

# Answer to a CONNECT whose target the rule allows and the proxy reached.
TUNNEL_ESTABLISHED_RESPONSE = b"HTTP/1.1 200 Connection Established\r\n\r\n"

# Ends a message head: the empty line after its last header.
HEAD_TERMINATOR = b"\r\n\r\n"

# Header added to each forwarded request and response head.
CONNECTION_CLOSE_HEADER = b"Connection: close"

# Headers of one connection, not of the message, which the proxy drops from
# what it passes on, in lowercase.
HOP_BY_HOP_HEADER_NAMES = frozenset(
    {
        b"connection",
        b"keep-alive",
        b"proxy-authenticate",
        b"proxy-authorization",
        b"proxy-connection",
        b"te",
        b"trailer",
        b"upgrade",
    }
)

# HTTP versions the proxy accepts in a request line.
SUPPORTED_HTTP_VERSIONS = frozenset({b"HTTP/1.0", b"HTTP/1.1"})

# Port of each URL scheme whose URLs name no port, as Chromium connects.
DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443}

# Most TCP port, inclusive; ports start at 1.
MAXIMUM_TCP_PORT = 65_535

# A CONNECT target: a bracketed IPv6 address or a host without colons, then
# a colon and a decimal port.
CONNECT_TARGET_PATTERN = re.compile(
    r"\[(?P<ipv6>[0-9A-Fa-f:.]+)\]:(?P<ipv6_port>[0-9]{1,5})"
    r"|(?P<host>[^:\[\]/@\s]+):(?P<port>[0-9]{1,5})"
)


@dataclass(frozen=True)
class ProxyTarget:
    """The host and port one proxied request is for.

    Only the parsing functions of this module build one, so ``host`` is
    always lowercase, without brackets, and non-empty, and ``port`` is from 1
    to MAXIMUM_TCP_PORT. Two targets are equal when both fields are, which is
    how the proxy matches a refusal with the URL Chromium could not load.
    """

    host: str
    """Host name or IP address, such as ``example.com`` or ``::1``."""
    port: int
    """TCP port."""


@dataclass(frozen=True)
class TunnelRequest:
    """A ``CONNECT`` request: the proxy tunnels bytes to the target."""

    target: ProxyTarget
    """Host and port the tunnel goes to."""


@dataclass(frozen=True)
class ForwardedRequest:
    """An absolute-form ``http://`` request: the proxy forwards it."""

    target: ProxyTarget
    """Host and port of the request's URL."""
    head: bytes
    """Head the target receives: the request line in origin form, the
    request's end-to-end headers, ``Connection: close``, and the empty line."""
    body_byte_count: int
    """Length of the request's body, from its ``Content-Length``; 0 without
    one."""


type ProxyRequest = TunnelRequest | ForwardedRequest
"""A request the proxy serves, by kind."""


@dataclass(frozen=True)
class RequestLine:
    """The parts of a request's first line, checked only for their count and
    version."""

    method: bytes
    """Method, such as ``GET`` or ``CONNECT``."""
    target: bytes
    """Untrusted request target, such as ``example.com:443`` or an
    ``http://`` URL."""
    version: bytes
    """``HTTP/1.0`` or ``HTTP/1.1``."""


def parse_request_head(head: bytes) -> ProxyRequest | None:
    """Parses the head of a request Chromium sent the proxy.

    Args:
        head: Untrusted bytes up to, not including, HEAD_TERMINATOR.

    Returns:
        The request; None when the proxy refuses it: a malformed head, a
        version other than HTTP/1.0 or 1.1, a target that is neither
        ``host:port`` for CONNECT nor an absolute ``http://`` URL with a host,
        a folded header line, a ``Transfer-Encoding``, or a ``Content-Length``
        that is not one decimal number.
    """
    first_line, *header_lines = head.split(b"\r\n")
    parts = first_line.split(b" ")
    headers = parse_header_lines(header_lines)
    if len(parts) != 3 or parts[2] not in SUPPORTED_HTTP_VERSIONS or headers is None:
        return None
    request_line = RequestLine(*parts)
    if request_line.method == b"CONNECT":
        target = parse_connect_target(request_line.target)
        return None if target is None else TunnelRequest(target)
    return parse_forwarded_request(request_line, headers)


def parse_header_lines(
    header_lines: list[bytes],
) -> list[tuple[bytes, bytes]] | None:
    """Splits header lines into names and lines.

    Args:
        header_lines: Untrusted lines of a message head after its first line.

    Returns:
        Each header's lowercase name with its whole line, in order; None when
        a line is folded, has no colon, or has an empty name or whitespace in
        it.
    """
    headers = []
    for line in header_lines:
        name, separator, _ = line.partition(b":")
        if not separator or not name or re.search(rb"\s", name):
            return None
        headers.append((name.lower(), line))
    return headers


def parse_connect_target(request_target: bytes) -> ProxyTarget | None:
    """Parses the target of a CONNECT request.

    Args:
        request_target: Untrusted target, such as ``example.com:443`` or
            ``[::1]:443``.

    Returns:
        The target; None when it is not a host and a port from 1 to
        MAXIMUM_TCP_PORT.
    """
    try:
        text = request_target.decode("ascii")
    except UnicodeDecodeError:
        return None
    match = CONNECT_TARGET_PATTERN.fullmatch(text)
    if match is None:
        return None
    host = match["ipv6"] or match["host"]
    port = int(match["ipv6_port"] or match["port"])
    if not 1 <= port <= MAXIMUM_TCP_PORT:
        return None
    return ProxyTarget(host.lower(), port)


def parse_forwarded_request(
    request_line: RequestLine, headers: list[tuple[bytes, bytes]]
) -> ForwardedRequest | None:
    """Builds the request the proxy forwards for an absolute-form request.

    Args:
        request_line: The request's first line, whose target must be an
            ``http://`` URL.
        headers: The request's headers, from parse_header_lines.

    Returns:
        The request in origin form; None when the target is not an absolute
        ``http://`` URL with a host, the request has a ``Transfer-Encoding``,
        or its ``Content-Length`` is not one decimal number.
    """
    try:
        url = request_line.target.decode("ascii")
    except UnicodeDecodeError:
        return None
    parts = urlsplit(url)
    target = find_url_target(url) if parts.scheme == "http" else None
    is_chunked = any(name == b"transfer-encoding" for name, _ in headers)
    body_byte_count = find_content_length(headers)
    if target is None or is_chunked or body_byte_count is None:
        return None
    query = f"?{parts.query}" if parts.query else ""
    origin_target = f"{parts.path or '/'}{query}".encode("ascii")
    first_line = b" ".join((request_line.method, origin_target, request_line.version))
    head = build_head(first_line, headers)
    return ForwardedRequest(target, head, body_byte_count)


def build_head(first_line: bytes, headers: list[tuple[bytes, bytes]]) -> bytes:
    """Builds a message head the proxy passes on.

    Args:
        first_line: The request or status line.
        headers: The message's headers, from parse_header_lines.

    Returns:
        The first line, the headers that are not hop-by-hop, in order,
        ``Connection: close``, and HEAD_TERMINATOR.
    """
    kept_lines = [line for name, line in headers if name not in HOP_BY_HOP_HEADER_NAMES]
    lines = (first_line, *kept_lines, CONNECTION_CLOSE_HEADER)
    return b"\r\n".join(lines) + HEAD_TERMINATOR


def find_content_length(headers: list[tuple[bytes, bytes]]) -> int | None:
    """Finds the length of a request's body.

    Args:
        headers: The request's headers.

    Returns:
        The ``Content-Length``; 0 without one; None when it is not one decimal
        number, or the request has several.
    """
    lengths = [line for name, line in headers if name == b"content-length"]
    if not lengths:
        return 0
    value = lengths[0].partition(b":")[2].strip()
    return int(value) if len(lengths) == 1 and value.isdigit() else None


def find_url_target(url: str) -> ProxyTarget | None:
    """Finds the host and port Chromium connects to for a URL.

    Args:
        url: Untrusted URL, such as the one a frame could not load.

    Returns:
        The URL's host, lowercase and unbracketed, and its port, or its
        scheme's default port; None for a URL without a host, with a port
        that is not from 1 to MAXIMUM_TCP_PORT, or without a port and of a
        scheme other than http, https, ws, and wss.
    """
    parts = urlsplit(url)
    try:
        explicit_port = parts.port
    except ValueError:
        return None
    port = DEFAULT_PORTS.get(parts.scheme) if explicit_port is None else explicit_port
    if not parts.hostname or port is None or not 1 <= port <= MAXIMUM_TCP_PORT:
        return None
    return ProxyTarget(parts.hostname, port)


def parse_response_head(head: bytes) -> bytes | None:
    """Parses a response head into the one Chromium receives, which keeps it
    from reusing the connection.

    Args:
        head: Untrusted bytes up to, not including, HEAD_TERMINATOR.

    Returns:
        The head without hop-by-hop headers, with ``Connection: close``, and
        with HEAD_TERMINATOR; None when the head is malformed or its first
        line is not an HTTP status line.
    """
    status_line, *header_lines = head.split(b"\r\n")
    headers = parse_header_lines(header_lines)
    if headers is None or not status_line.startswith(b"HTTP/"):
        return None
    return build_head(status_line, headers)
