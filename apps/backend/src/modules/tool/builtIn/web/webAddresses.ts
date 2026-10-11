import { BlockList, isIP } from "node:net"

/** One address range written as its first address and prefix length. */
type AddressRange = readonly [address: string, prefixLength: number]

/**
 * IPv4 ranges Lys never connects to: this host, private and shared networks,
 * link-local addresses, ranges reserved for protocols, documentation, and
 * benchmarking, multicast, and the reserved block that holds the broadcast
 * address.
 */
const BLOCKED_IPV4_RANGES: readonly AddressRange[] = Object.freeze([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
])

/**
 * IPv6 ranges Lys never connects to: the unspecified and loopback addresses
 * with the deprecated IPv4-compatible block that holds them, NAT64 and 6to4
 * prefixes, whose embedded IPv4 address could be private, the discard and
 * protocol-assignment blocks, documentation, unique-local, link-local,
 * site-local, and multicast addresses. An IPv4-mapped address is checked
 * against the IPv4 ranges by the block list itself.
 */
const BLOCKED_IPV6_RANGES: readonly AddressRange[] = Object.freeze([
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
])

/**
 * Builds the list of every blocked range.
 *
 * @returns A new list holding {@link BLOCKED_IPV4_RANGES} and
 * {@link BLOCKED_IPV6_RANGES}.
 */
function buildBlockedAddressList(): BlockList {
  const blockedAddresses = new BlockList()
  for (const [address, prefixLength] of BLOCKED_IPV4_RANGES) {
    blockedAddresses.addSubnet(address, prefixLength, "ipv4")
  }
  for (const [address, prefixLength] of BLOCKED_IPV6_RANGES) {
    blockedAddresses.addSubnet(address, prefixLength, "ipv6")
  }
  return blockedAddresses
}

/**
 * Every range Lys never connects to.
 *
 * @remarks The list is a mutable Node object, so it stays private to this
 * module and is only read through {@link isBlockedAddress}.
 */
const BLOCKED_ADDRESSES = buildBlockedAddressList()

/**
 * Answers whether Lys must not connect to an address.
 *
 * @param address - IPv4 or IPv6 address without brackets, as a URL host
 * (unbracketed) or a name lookup gives it.
 * @returns True when the address is in a blocked range, and also when the
 * value is not an IP address at all, so a malformed value is never
 * connected to.
 */
export function isBlockedAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return BLOCKED_ADDRESSES.check(address, "ipv4")
    case 6:
      return BLOCKED_ADDRESSES.check(address, "ipv6")
    default:
      return true
  }
}

/**
 * Answers whether a host name always means this machine.
 *
 * @param hostname - Host name as the URL parser normalized it: lowercase,
 * possibly with a trailing dot.
 * @returns True for `localhost` and any name under `.localhost`, which
 * resolvers send to this machine without asking DNS.
 */
export function isLocalHostName(hostname: string): boolean {
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname
  return name === "localhost" || name.endsWith(".localhost")
}
