import { BlockList, isIP } from "node:net"
import * as z from "zod"
import committedBlockedAddressRangesFile from "./blocked_address_ranges.json" with { type: "json" }

/**
 * Validates the committed `blocked_address_ranges.json`: the IPv4 and IPv6
 * ranges Lys never connects to, each written in CIDR notation.
 */
const blockedAddressRangesSchema = z
  .strictObject({
    /** IPv4 ranges, such as `10.0.0.0/8`. */
    ipv4: z.array(z.cidrv4()).readonly(),
    /** IPv6 ranges, such as `fc00::/7`. */
    ipv6: z.array(z.cidrv6()).readonly()
  })
  .readonly()

/** Every range Lys never connects to, in CIDR notation, by address family. */
type BlockedAddressRanges = z.infer<typeof blockedAddressRangesSchema>

/**
 * Ranges Lys never connects to. IPv4: this host, private and shared networks,
 * link-local addresses, ranges reserved for protocols, documentation, and
 * benchmarking, multicast, and the reserved block that holds the broadcast
 * address. IPv6: the unspecified and loopback addresses with the deprecated
 * IPv4-compatible block that holds them, NAT64 and 6to4 prefixes, whose
 * embedded IPv4 address could be private, the discard and
 * protocol-assignment blocks, documentation, unique-local, link-local,
 * site-local, and multicast addresses.
 *
 * @remarks Read from the committed `blocked_address_ranges.json`, which the
 * backend bundle embeds when it is built. The `lys-readpage` image copies the
 * same file, so the proxy in each read's micro VM applies these ranges too.
 * Evaluating this module validates the file, so an invalid range stops the
 * backend at startup instead of letting a connection through.
 */
const BLOCKED_ADDRESS_RANGES: BlockedAddressRanges =
  blockedAddressRangesSchema.parse(committedBlockedAddressRangesFile)

/**
 * Adds ranges of one address family to a block list.
 *
 * @param blockedAddresses - List being built, which this changes.
 * @param ranges - Ranges in CIDR notation, validated by
 * {@link blockedAddressRangesSchema}.
 * @param family - Address family of every range.
 */
function addBlockedSubnets(
  blockedAddresses: BlockList,
  ranges: readonly string[],
  family: "ipv4" | "ipv6"
): void {
  for (const range of ranges) {
    const slashIndex = range.indexOf("/")
    const address = range.slice(0, slashIndex)
    const prefixLength = Number(range.slice(slashIndex + 1))
    blockedAddresses.addSubnet(address, prefixLength, family)
  }
}

/**
 * Builds the list of every blocked range.
 *
 * @returns A new list holding {@link BLOCKED_ADDRESS_RANGES}. An IPv4-mapped
 * IPv6 address is checked against its IPv4 ranges by the list itself.
 */
function buildBlockedAddressList(): BlockList {
  const blockedAddresses = new BlockList()
  addBlockedSubnets(blockedAddresses, BLOCKED_ADDRESS_RANGES.ipv4, "ipv4")
  addBlockedSubnets(blockedAddresses, BLOCKED_ADDRESS_RANGES.ipv6, "ipv6")
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
