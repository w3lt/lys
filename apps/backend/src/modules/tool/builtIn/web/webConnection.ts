import type { LookupAddress, LookupOptions } from "node:dns"
import { lookup as lookupDns } from "node:dns/promises"
import type { LookupFunction, Socket } from "node:net"

/** One address a host name resolves to. */
export type HostAddress = Readonly<{
  /** IPv4 or IPv6 address, without brackets. */
  address: string
  /** Address family. */
  family: 4 | 6
}>

/**
 * Resolves a host name to every address it has, in the resolver's order.
 * Rejects when the name has no address or the lookup fails.
 */
export type HostAddressLookup = (
  hostname: string
) => Promise<readonly HostAddress[]>

/** What every address-checked connection needs from its environment. */
export type ConnectionAddressRule = Readonly<{
  /** Resolves each host name the connection goes to. */
  lookupHostAddresses: HostAddressLookup
  /** Answers whether Lys must not connect to an address. */
  isBlockedAddress: (address: string) => boolean
}>

/** Why a connection was refused before or as it was made. */
export type ConnectionAddressFailureKind =
  "blocked-address" | "unresolvable-host"

/**
 * User agent of every request Lys sends to the web: it names Lys and links to
 * its source, in the form sites expect from automated readers.
 */
export const LYS_USER_AGENT =
  "Mozilla/5.0 (compatible; Lys; +https://github.com/w3lt/lys)"

/**
 * A connection refused by the address rule or without any address, carried
 * through Node's lookup and socket error channels.
 */
export class ConnectionAddressError extends Error {
  /** Why the connection was refused. */
  readonly #kind: ConnectionAddressFailureKind

  /**
   * Creates the error for one refused connection.
   *
   * @param kind - Why the connection was refused.
   * @param cause - Underlying lookup failure, when one exists.
   */
  public constructor(kind: ConnectionAddressFailureKind, cause?: unknown) {
    super(`Connection refused: ${kind}`, { cause })
    this.#kind = kind
  }

  /**
   * Why the connection was refused.
   *
   * @returns The kind given at creation.
   */
  public get kind(): ConnectionAddressFailureKind {
    return this.#kind
  }
}

/**
 * Resolves a host name through the operating system's resolver.
 *
 * @param hostname - Host name of a URL Lys connects to.
 * @returns Every address the resolver gives, in its order.
 * @throws The resolver's failure, such as `ENOTFOUND` for an unknown name.
 */
export async function lookupDnsHostAddresses(
  hostname: string
): Promise<readonly HostAddress[]> {
  const records = await lookupDns(hostname, { all: true, order: "verbatim" })
  return Object.freeze(
    records.map(({ address, family }) =>
      Object.freeze({ address, family: family === 6 ? 6 : 4 })
    )
  )
}

/**
 * Answers whether a failure carries a system or TLS error code.
 *
 * @param error - Untrusted failure.
 * @returns True for an `Error` whose `code` is a non-empty string.
 */
export function hasErrorCode(
  error: unknown
): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code !== ""
  )
}

/**
 * Checks one chunk read from a web response body stream.
 *
 * @param chunk - Untrusted chunk; body and decompression streams without an
 * encoding yield bytes.
 * @returns The chunk's bytes.
 * @throws A `TypeError` when the stream yielded something else.
 */
export function parseResponseChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  throw new TypeError(
    "A web response body stream yielded a chunk that is not bytes"
  )
}

/**
 * Resolves a host name and refuses it when any address is blocked.
 *
 * @param hostname - Host name the connection is for.
 * @param rule - Lookup and address rule.
 * @returns Every address, in the resolver's order, when none is blocked.
 * @throws A {@link ConnectionAddressError} for a blocked or missing address,
 * or for a lookup failure with a system code; any other lookup failure
 * unchanged.
 */
async function resolveCheckedHostAddresses(
  hostname: string,
  rule: ConnectionAddressRule
): Promise<readonly HostAddress[]> {
  const addresses = await rule
    .lookupHostAddresses(hostname)
    .catch((error: unknown) => {
      if (!hasErrorCode(error)) throw error
      throw new ConnectionAddressError("unresolvable-host", error)
    })
  if (addresses.length === 0) {
    throw new ConnectionAddressError("unresolvable-host")
  }
  if (addresses.some(({ address }) => rule.isBlockedAddress(address))) {
    throw new ConnectionAddressError("blocked-address")
  }
  return addresses
}

/**
 * Finds the address family a Node lookup asks for.
 *
 * @param options - Node's lookup options.
 * @returns 4 or 6 when the lookup is limited to that family, and undefined
 * when any family is accepted.
 */
function findRequestedFamily(options: LookupOptions): 4 | 6 | undefined {
  switch (options.family) {
    case 4:
    case "IPv4":
      return 4
    case 6:
    case "IPv6":
      return 6
    default:
      return undefined
  }
}

/**
 * Builds the address entry Node's lookup callback takes.
 *
 * @param hostAddress - Checked address.
 * @returns A new mutable entry, as Node's callback type requires.
 */
function buildLookupAddress(hostAddress: HostAddress): LookupAddress {
  return { address: hostAddress.address, family: hostAddress.family }
}

/**
 * Delivers resolved addresses in the form Node's connection asked for.
 *
 * @param addresses - Checked addresses, at least one.
 * @param options - Node's lookup options; `all` asks for every address and
 * `family` limits them to one family.
 * @param callback - Node's lookup callback.
 */
function deliverHostAddresses(
  addresses: readonly HostAddress[],
  options: LookupOptions,
  callback: Parameters<LookupFunction>[2]
): void {
  const family = findRequestedFamily(options)
  const eligible = addresses.filter(
    (address) => family === undefined || address.family === family
  )
  const [first] = eligible
  if (first === undefined) {
    callback(new ConnectionAddressError("unresolvable-host"), "")
    return
  }
  if (options.all === true) {
    callback(null, eligible.map(buildLookupAddress))
    return
  }
  callback(null, first.address, first.family)
}

/**
 * Converts a lookup failure into the error type Node's lookup callback takes.
 *
 * @param error - Failure from {@link resolveCheckedHostAddresses}.
 * @returns The same error when it is an `Error`, or a new one wrapping it.
 */
function toErrnoException(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error
    ? error
    : new Error("Host lookup failed", { cause: error })
}

/**
 * Creates the lookup every checked connection uses.
 *
 * @param rule - Lookup and address rule.
 * @returns A Node lookup that refuses a host when any of its addresses is
 * blocked, so a connection only ever goes to a checked address.
 */
export function createCheckedLookup(
  rule: ConnectionAddressRule
): LookupFunction {
  return (hostname, options, callback) => {
    resolveCheckedHostAddresses(hostname, rule).then(
      (addresses) => deliverHostAddresses(addresses, options, callback),
      (error: unknown) => callback(toErrnoException(error), "")
    )
  }
}

/**
 * Destroys a socket whose connected address is blocked.
 *
 * @param socket - Socket of one request.
 * @param isBlockedAddress - Address rule.
 * @remarks Checks the address the socket actually reached, which also
 * covers a URL whose host is an IP address and so needs no lookup.
 */
function checkConnectedAddress(
  socket: Socket,
  isBlockedAddress: (address: string) => boolean
): void {
  const address = socket.remoteAddress
  if (address === undefined || isBlockedAddress(address)) {
    socket.destroy(new ConnectionAddressError("blocked-address"))
  }
}

/**
 * Starts checking the address a request's socket connects to.
 *
 * @param socket - Socket Node assigned to the request.
 * @param isBlockedAddress - Address rule.
 */
export function watchConnectedAddress(
  socket: Socket,
  isBlockedAddress: (address: string) => boolean
): void {
  if (socket.connecting) {
    socket.once("connect", () =>
      checkConnectedAddress(socket, isBlockedAddress)
    )
    return
  }
  checkConnectedAddress(socket, isBlockedAddress)
}
