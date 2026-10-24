"""Decides which addresses the reader's proxy never connects to.

The ranges are the backend's: the image copies
``apps/backend/src/modules/tool/builtIn/web/blocked_address_ranges.json``
next to this file, so the proxy applies the rule ``isBlockedAddress`` in
``webAddresses.ts`` applies, IPv4-mapped IPv6 addresses included.
"""

import ipaddress
import json
from dataclasses import dataclass
from pathlib import Path

# The ranges, which the image copies next to this file.
BLOCKED_ADDRESS_RANGES_PATH = Path(__file__).with_name("blocked_address_ranges.json")


@dataclass(frozen=True)
class BlockedAddressRanges:
    """Every range the reader never connects to, by address family.

    Only load_blocked_address_ranges builds one from the backend's file; tests
    build their own. It is immutable, so any thread may read it.
    """

    ipv4_networks: tuple[ipaddress.IPv4Network, ...]
    """IPv4 ranges, such as ``10.0.0.0/8``."""
    ipv6_networks: tuple[ipaddress.IPv6Network, ...]
    """IPv6 ranges, such as ``fc00::/7``. An IPv4-mapped address is checked
    against the IPv4 ranges as well."""


def load_blocked_address_ranges(path: Path) -> BlockedAddressRanges:
    """Reads the blocked ranges from the backend's JSON file.

    Args:
        path: A UTF-8 JSON object whose ``ipv4`` and ``ipv6`` lists hold
            ranges in CIDR notation, and nothing else.

    Returns:
        The ranges.

    Raises:
        OSError: The file could not be read.
        ValueError: The file is not that JSON object, or a range is not a
            network of its family in CIDR notation.
    """
    ranges = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(ranges, dict) or set(ranges) != {"ipv4", "ipv6"}:
        raise ValueError(f"{path} does not hold exactly ipv4 and ipv6 ranges")
    return BlockedAddressRanges(
        ipv4_networks=tuple(
            parse_network(text, ipaddress.IPv4Network) for text in ranges["ipv4"]
        ),
        ipv6_networks=tuple(
            parse_network(text, ipaddress.IPv6Network) for text in ranges["ipv6"]
        ),
    )


def parse_network[NetworkType: (ipaddress.IPv4Network, ipaddress.IPv6Network)](
    text: object, network_type: type[NetworkType]
) -> NetworkType:
    """Parses one range of the ranges file.

    Args:
        text: The range as the file holds it, such as ``10.0.0.0/8``.
        network_type: The range's address family.

    Returns:
        The range.

    Raises:
        ValueError: The range is not a string naming a network of that family
            in CIDR notation, with no host bits set.
    """
    if not isinstance(text, str) or "/" not in text:
        raise ValueError(f"{text!r} is not a range in CIDR notation")
    return network_type(text)


def is_blocked_address(address: str, ranges: BlockedAddressRanges) -> bool:
    """Answers whether the reader must not connect to an address.

    Args:
        address: IPv4 or IPv6 address without brackets, as a name lookup gives
            it; an IPv6 address may carry a ``%`` zone.
        ranges: The blocked ranges.

    Returns:
        True when the address is in a blocked range, an IPv4-mapped IPv6
        address included when its IPv4 address is, and also when the value is
        not an IP address at all, so a malformed value is never connected to.
    """
    try:
        parsed_address = ipaddress.ip_address(address)
    except ValueError:
        return True
    if isinstance(parsed_address, ipaddress.IPv4Address):
        return any(parsed_address in network for network in ranges.ipv4_networks)
    mapped_address = parsed_address.ipv4_mapped
    if mapped_address is not None and any(
        mapped_address in network for network in ranges.ipv4_networks
    ):
        return True
    return any(parsed_address in network for network in ranges.ipv6_networks)
