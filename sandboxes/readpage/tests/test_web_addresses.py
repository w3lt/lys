"""Tests of web_addresses with the backend's own ranges file."""

import json
import tempfile
import unittest
from pathlib import Path

from web_addresses import (
    is_blocked_address,
    load_blocked_address_ranges,
)

# The backend's ranges file, which the image copies next to web_addresses.py.
BACKEND_RANGES_PATH = (
    Path(__file__).resolve().parents[3]
    / "apps/backend/src/modules/tool/builtIn/web/blocked_address_ranges.json"
)


class BlockedAddressTests(unittest.TestCase):
    """The rule gives the answers the backend's webAddresses.test.ts expects."""

    @classmethod
    def setUpClass(cls) -> None:
        """Loads the backend's ranges once; the value is immutable."""
        cls.ranges = load_blocked_address_ranges(BACKEND_RANGES_PATH)

    def test_blocks_reserved_and_private_addresses(self) -> None:
        blocked_addresses = {
            "this host": "0.0.0.0",
            "a private 10/8 address": "10.1.2.3",
            "a shared 100.64/10 address": "100.64.0.1",
            "the last shared 100.64/10 address": "100.127.255.255",
            "a loopback address": "127.0.0.1",
            "another loopback address": "127.255.0.9",
            "a link-local address": "169.254.169.254",
            "the first private 172.16/12 address": "172.16.0.0",
            "the last private 172.16/12 address": "172.31.255.255",
            "a protocol-assignment address": "192.0.0.8",
            "a documentation address": "192.0.2.10",
            "a 6to4 relay address": "192.88.99.1",
            "a private 192.168/16 address": "192.168.1.1",
            "a benchmarking address": "198.19.0.1",
            "a multicast address": "224.0.0.251",
            "the broadcast address": "255.255.255.255",
            "the unspecified IPv6 address": "::",
            "the IPv6 loopback address": "::1",
            "an IPv4-compatible loopback address": "::7f00:1",
            "an IPv4-mapped loopback address in hex": "::ffff:7f00:1",
            "an IPv4-mapped loopback address in dotted form": "::ffff:127.0.0.1",
            "an IPv4-mapped private address": "::ffff:192.168.0.1",
            "a NAT64 address": "64:ff9b::808:808",
            "a 6to4 address": "2002:c0a8:101::1",
            "a Teredo address": "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "an IPv6 documentation address": "2001:db8::1",
            "a unique-local address": "fd12:3456::1",
            "a link-local IPv6 address": "fe80::1",
            "a link-local IPv6 address with a zone": "fe80::1%eth0",
            "a site-local IPv6 address": "fec0::1",
            "a multicast IPv6 address": "ff02::1",
        }
        for label, address in blocked_addresses.items():
            with self.subTest(label, address=address):
                self.assertTrue(is_blocked_address(address, self.ranges))

    def test_allows_public_addresses(self) -> None:
        allowed_addresses = {
            "a public IPv4 address": "93.184.215.14",
            "the address before 100.64/10": "100.63.255.255",
            "the address after 100.64/10": "100.128.0.0",
            "the address before 172.16/12": "172.15.255.255",
            "the address after 172.16/12": "172.32.0.0",
            "a public IPv6 address": "2606:4700:4700::1111",
            "an IPv4-mapped public address": "::ffff:8.8.8.8",
        }
        for label, address in allowed_addresses.items():
            with self.subTest(label, address=address):
                self.assertFalse(is_blocked_address(address, self.ranges))

    def test_blocks_values_that_are_not_ip_addresses(self) -> None:
        values = {
            "a host name": "example.com",
            "an empty value": "",
            "a bracketed IPv6 address": "[::1]",
        }
        for label, value in values.items():
            with self.subTest(label, value=value):
                self.assertTrue(is_blocked_address(value, self.ranges))


class RangesFileTests(unittest.TestCase):
    """load_blocked_address_ranges refuses a file that is not the ranges file."""

    def test_refuses_malformed_files(self) -> None:
        malformed_files = {
            "a list": ["10.0.0.0/8"],
            "a missing family": {"ipv4": ["10.0.0.0/8"]},
            "an extra field": {"ipv4": [], "ipv6": [], "ipv5": []},
            "a range without a prefix length": {"ipv4": ["10.0.0.1"], "ipv6": []},
            "a range with host bits": {"ipv4": ["10.0.0.1/8"], "ipv6": []},
            "an IPv6 range among IPv4 ones": {"ipv4": ["fc00::/7"], "ipv6": []},
            "a range that is not a string": {"ipv4": [10], "ipv6": []},
        }
        for label, content in malformed_files.items():
            with self.subTest(label), tempfile.TemporaryDirectory() as directory:
                path = Path(directory, "blocked_address_ranges.json")
                path.write_text(json.dumps(content), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_blocked_address_ranges(path)


if __name__ == "__main__":
    unittest.main()
