import type { LookupAddress, LookupOptions } from "node:dns"
import { lookup as lookupDns } from "node:dns/promises"
import {
  request as requestHttp,
  type IncomingMessage,
  type RequestOptions
} from "node:http"
import { request as requestHttps } from "node:https"
import type { LookupFunction, Socket } from "node:net"
import type { Readable, Transform } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { decodePageText, type PageMediaType } from "./pageCharset"
import {
  parsePageUrl,
  type PageUrl,
  type PageUrlProblem,
  type PageUrlResult
} from "./pageUrl"

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

/**
 * Resolves a host name through the operating system's resolver.
 *
 * @param hostname - Host name of a page URL.
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

/** What one page request needs from its environment. */
export type PageRequestDependencies = Readonly<{
  /** Resolves each host name the request connects to. */
  lookupHostAddresses: HostAddressLookup
  /** Answers whether Lys must not connect to an address. */
  isBlockedAddress: (address: string) => boolean
  /**
   * Most milliseconds the whole request may take, redirects and body
   * included; a positive integer.
   */
  requestTimeoutMs: number
}>

/** A page body Lys read. */
export type PageResponse = Readonly<{
  /** URL the body came from, after every redirect. */
  url: PageUrl
  /** Media type of the body. */
  mediaType: PageMediaType
  /** Decoded body text. */
  text: string
  /**
   * Whether the body was longer than {@link MAXIMUM_PAGE_BODY_BYTES} and
   * only its beginning was read.
   */
  isTruncated: boolean
}>

/** Why a page could not be read. */
export type PageRequestFailure =
  | Readonly<{
      /** A host name resolved to, or a connection reached, a blocked address. */
      kind: "blocked-address"
    }>
  | Readonly<{
      /** A host name has no address. */
      kind: "unresolvable-host"
    }>
  | Readonly<{
      /** A redirect pointed somewhere Lys may not request. */
      kind: "invalid-redirect"
      /** Why the redirect target may not be requested. */
      problem: PageUrlProblem
    }>
  | Readonly<{
      /** The page redirected more than {@link MAXIMUM_PAGE_REDIRECTS} times. */
      kind: "too-many-redirects"
    }>
  | Readonly<{
      /** The request took longer than its time limit. */
      kind: "timed-out"
    }>
  | Readonly<{
      /**
       * The connection could not be made or broke, or the body could not be
       * decompressed.
       */
      kind: "transfer-failed"
      /** System, TLS, or decompression error code, such as `ECONNREFUSED`. */
      code: string
    }>
  | Readonly<{
      /** The server answered with a status other than 2xx. */
      kind: "http-status"
      /** HTTP status code the server sent. */
      status: number
    }>
  | Readonly<{
      /** The body is not HTML or plain text. */
      kind: "unsupported-content-type"
      /** Media type the server named; undefined when it named none. */
      mediaType: string | undefined
    }>
  | Readonly<{
      /** The body uses a compression Lys does not decode. */
      kind: "unsupported-encoding"
      /** Content encoding the server named. */
      encoding: string
    }>

/** Outcome of one page request. */
export type PageRequestResult =
  | Readonly<{
      /** The page was read. */
      status: "succeeded"
      /** Body and the URL it came from. */
      page: PageResponse
    }>
  | Readonly<{
      /** The page could not be read. */
      status: "failed"
      /** Why. */
      failure: PageRequestFailure
    }>

/** Most redirects one request follows, inclusive. */
export const MAXIMUM_PAGE_REDIRECTS = 5

/** Most decompressed body bytes read from one page, inclusive. */
export const MAXIMUM_PAGE_BODY_BYTES = 4 * 1024 * 1024

/** Status codes whose `Location` header Lys follows. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308
])

/** Media types Lys reads, mapped to how it reads them. */
const PAGE_MEDIA_TYPES: ReadonlyMap<string, PageMediaType> = new Map([
  ["text/html", "text/html"],
  ["application/xhtml+xml", "text/html"],
  ["text/plain", "text/plain"]
])

/**
 * Headers sent with every page request.
 *
 * @remarks The user agent names Lys and links to its source, in the form
 * sites already expect from automated readers. No cookie or credential is
 * ever sent.
 */
const PAGE_REQUEST_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (compatible; Lys; +https://github.com/w3lt/lys)",
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
  "accept-encoding": "gzip, deflate, br"
})

/** A request failure Lys recognizes, carried through Node's error channels. */
class PageRequestFailureError extends Error {
  /** Recognized failure this error carries. */
  readonly #failure: PageRequestFailure

  /**
   * Creates the error for one failure occurrence.
   *
   * @param failure - Recognized failure.
   * @param cause - Underlying failure, when one exists.
   */
  public constructor(failure: PageRequestFailure, cause?: unknown) {
    super(`Page request failed: ${failure.kind}`, { cause })
    this.#failure = Object.freeze(failure)
  }

  /**
   * Recognized failure this error carries.
   *
   * @returns The frozen failure given at creation.
   */
  public get failure(): PageRequestFailure {
    return this.#failure
  }
}

/**
 * Builds a failed outcome.
 *
 * @param failure - Why the page could not be read.
 * @returns A frozen failed result.
 */
function buildFailedPageResult(failure: PageRequestFailure): PageRequestResult {
  return Object.freeze({ status: "failed", failure })
}

/**
 * Resolves a host name and refuses it when any address is blocked.
 *
 * @param hostname - Host name the connection is for.
 * @param dependencies - Lookup and address rule.
 * @returns Every address, in the resolver's order, when none is blocked.
 * @throws A {@link PageRequestFailureError} for a blocked or missing address,
 * or for a lookup failure with a system code; any other lookup failure
 * unchanged.
 */
async function resolvePageHostAddresses(
  hostname: string,
  dependencies: PageRequestDependencies
): Promise<readonly HostAddress[]> {
  const addresses = await dependencies
    .lookupHostAddresses(hostname)
    .catch((error: unknown) => {
      if (!hasErrorCode(error)) throw error
      throw new PageRequestFailureError({ kind: "unresolvable-host" }, error)
    })
  if (addresses.length === 0) {
    throw new PageRequestFailureError({ kind: "unresolvable-host" })
  }
  if (addresses.some(({ address }) => dependencies.isBlockedAddress(address))) {
    throw new PageRequestFailureError({ kind: "blocked-address" })
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
    callback(new PageRequestFailureError({ kind: "unresolvable-host" }), "")
    return
  }
  if (options.all === true) {
    callback(null, eligible.map(buildLookupAddress))
    return
  }
  callback(null, first.address, first.family)
}

/**
 * Creates the lookup every page connection uses.
 *
 * @param dependencies - Lookup and address rule.
 * @returns A Node lookup that refuses a host when any of its addresses is
 * blocked, so a connection only ever goes to a checked address.
 */
function createPageLookup(
  dependencies: PageRequestDependencies
): LookupFunction {
  return (hostname, options, callback) => {
    resolvePageHostAddresses(hostname, dependencies).then(
      (addresses) => deliverHostAddresses(addresses, options, callback),
      (error: unknown) => callback(toErrnoException(error), "")
    )
  }
}

/**
 * Converts a lookup failure into the error type Node's lookup callback takes.
 *
 * @param error - Failure from {@link resolvePageHostAddresses}.
 * @returns The same error when it is an `Error`, or a new one wrapping it.
 */
function toErrnoException(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error
    ? error
    : new Error("Host lookup failed", { cause: error })
}

/**
 * Destroys a socket whose connected address is blocked.
 *
 * @param socket - Socket of one page request.
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
    socket.destroy(new PageRequestFailureError({ kind: "blocked-address" }))
  }
}

/**
 * Starts checking the address a request's socket connects to.
 *
 * @param socket - Socket Node assigned to the request.
 * @param isBlockedAddress - Address rule.
 */
function watchConnectedAddress(
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

/**
 * Sends one GET request and waits for its response headers.
 *
 * @param url - Checked page URL.
 * @param signal - Aborts the request on Stop or when its time is up.
 * @param dependencies - Lookup and address rule.
 * @returns The response, whose body the caller owns and must consume or
 * destroy.
 * @throws The request's failure, including a {@link PageRequestFailureError}
 * for a blocked address.
 */
function openPageResponse(
  url: PageUrl,
  signal: AbortSignal,
  dependencies: PageRequestDependencies
): Promise<IncomingMessage> {
  const target = new URL(url)
  const sendRequest = target.protocol === "https:" ? requestHttps : requestHttp
  const options: RequestOptions = {
    method: "GET",
    headers: PAGE_REQUEST_HEADERS,
    agent: false,
    lookup: createPageLookup(dependencies),
    signal
  }
  return new Promise((resolve, reject) => {
    const request = sendRequest(target, options, resolve)
    // Stays attached: a failure after the response arrived, such as the
    // socket closing when the body is destroyed, must not go unhandled. The
    // promise is settled by then, so rejecting again changes nothing.
    request.on("error", reject)
    request.once("socket", (socket: Socket) =>
      watchConnectedAddress(socket, dependencies.isBlockedAddress)
    )
    request.end()
  })
}

/**
 * Finds where a response redirects to.
 *
 * @param response - Response whose headers arrived.
 * @returns The `Location` text of a redirect status, or undefined when the
 * response is not a redirect or names no target.
 */
function findRedirectLocation(response: IncomingMessage): string | undefined {
  if (!REDIRECT_STATUSES.has(response.statusCode ?? 0)) return undefined
  return response.headers.location
}

/** Outcome of a redirect target that cannot be parsed even against its page. */
const UNPARSABLE_REDIRECT: PageUrlResult = Object.freeze({
  status: "invalid",
  problem: "not-absolute"
})

/**
 * Checks a redirect target against the page URL rules.
 *
 * @param location - `Location` header text, possibly relative.
 * @param baseUrl - URL of the response that redirected.
 * @returns The parsed target; a target that cannot be parsed is not
 * absolute.
 */
function parseRedirectUrl(location: string, baseUrl: PageUrl): PageUrlResult {
  const target = URL.parse(location, baseUrl)
  return target === null ? UNPARSABLE_REDIRECT : parsePageUrl(target.href)
}

/** Media type and charset of a `Content-Type` header. */
type PageContentType = Readonly<{
  /** Lowercase media type without parameters. */
  mediaType: string
  /** Charset parameter, or undefined when the header names none. */
  charset: string | undefined
}>

/**
 * Parses a `Content-Type` header.
 *
 * @param header - Header text, or undefined when the response has none.
 * @returns The media type and charset, or undefined without a header.
 */
function parseContentType(
  header: string | undefined
): PageContentType | undefined {
  if (header === undefined) return undefined
  const [mediaType = "", ...parameters] = header.split(";")
  const charsetParameter = parameters
    .map((parameter) => parameter.trim())
    .find((parameter) => parameter.toLowerCase().startsWith("charset="))
  const charset = charsetParameter
    ?.slice("charset=".length)
    .replace(/^"|"$/g, "")
  return Object.freeze({ mediaType: mediaType.trim().toLowerCase(), charset })
}

/**
 * Pipes a body through a decompressor, passing a body failure on to it.
 *
 * @param response - Response whose body is decompressed.
 * @param decompressor - Decompression stream the body is piped into.
 * @returns The decompressor, which fails when the body fails, so whoever
 * reads it observes both failures.
 */
function pipeDecompressedBody(
  response: IncomingMessage,
  decompressor: Transform
): Readable {
  response.once("error", (error) => decompressor.destroy(error))
  return response.pipe(decompressor)
}

/**
 * Opens the decompressed stream of a body.
 *
 * @param response - Response whose body is read; the caller destroys it
 * once reading ends.
 * @returns The decompressed body, or the encoding Lys does not decode.
 */
function openDecodedBody(
  response: IncomingMessage
): Readable | Readonly<{ unsupportedEncoding: string }> {
  const encoding = (response.headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase()
  switch (encoding) {
    case "identity":
      return response
    case "gzip":
    case "x-gzip":
      return pipeDecompressedBody(response, createGunzip())
    case "deflate":
      return pipeDecompressedBody(response, createInflate())
    case "br":
      return pipeDecompressedBody(response, createBrotliDecompress())
    default:
      return Object.freeze({ unsupportedEncoding: encoding })
  }
}

/**
 * Checks one chunk read from a body stream.
 *
 * @param chunk - Untrusted chunk; body and decompression streams without an
 * encoding yield bytes.
 * @returns The chunk's bytes.
 * @throws A `TypeError` when the stream yielded something else.
 */
function parseBodyChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  throw new TypeError("A page body stream yielded a chunk that is not bytes")
}

/** Bytes read from a body and whether reading stopped at the limit. */
type PageBodyBytes = Readonly<{
  /** Bytes read, at most {@link MAXIMUM_PAGE_BODY_BYTES}. */
  bytes: Uint8Array
  /** Whether the body had more bytes than the limit. */
  isTruncated: boolean
}>

/**
 * Reads a body up to {@link MAXIMUM_PAGE_BODY_BYTES}.
 *
 * @param body - Decompressed body stream; reading stops, and the stream is
 * destroyed, once the limit is reached.
 * @returns The bytes and whether the body was longer.
 * @throws The stream's failure, such as an aborted request.
 */
async function readPageBodyBytes(body: Readable): Promise<PageBodyBytes> {
  const chunks: Uint8Array[] = []
  let byteCount = 0
  for await (const chunk of body) {
    const bytes = parseBodyChunk(chunk)
    const remainingBytes = MAXIMUM_PAGE_BODY_BYTES - byteCount
    chunks.push(bytes.subarray(0, remainingBytes))
    byteCount += Math.min(bytes.length, remainingBytes)
    if (bytes.length > remainingBytes) {
      return Object.freeze({ bytes: Buffer.concat(chunks), isTruncated: true })
    }
  }
  return Object.freeze({ bytes: Buffer.concat(chunks), isTruncated: false })
}

/**
 * Reads a final, non-redirect response into a page.
 *
 * @param url - URL the response came from.
 * @param response - Response whose headers arrived; it is consumed or
 * destroyed before this settles.
 * @returns The page, or why it cannot be read: a status other than 2xx, a
 * body that is not HTML or plain text, or an unsupported compression.
 * @throws A body read failure.
 */
async function readPageResponse(
  url: PageUrl,
  response: IncomingMessage
): Promise<PageRequestResult> {
  const status = response.statusCode ?? 0
  const contentType = parseContentType(response.headers["content-type"])
  const mediaType = PAGE_MEDIA_TYPES.get(contentType?.mediaType ?? "")
  if (status < 200 || status > 299) {
    response.destroy()
    return buildFailedPageResult({ kind: "http-status", status })
  }
  if (contentType === undefined || mediaType === undefined) {
    response.destroy()
    return buildFailedPageResult({
      kind: "unsupported-content-type",
      mediaType: contentType?.mediaType
    })
  }
  const body = openDecodedBody(response)
  if ("unsupportedEncoding" in body) {
    response.destroy()
    return buildFailedPageResult({
      kind: "unsupported-encoding",
      encoding: body.unsupportedEncoding
    })
  }
  try {
    const { bytes, isTruncated } = await readPageBodyBytes(body)
    const text = decodePageText(bytes, contentType.charset, mediaType)
    return Object.freeze({
      status: "succeeded",
      page: Object.freeze({ url, mediaType, text, isTruncated })
    })
  } finally {
    response.destroy()
  }
}

/**
 * Requests a page, following redirects that pass the page URL rules.
 *
 * @param url - Checked page URL.
 * @param signal - Aborts the request on Stop or when its time is up.
 * @param dependencies - Lookup and address rule.
 * @returns The page, or why it cannot be read.
 * @throws A request or body failure, including a
 * {@link PageRequestFailureError}.
 */
async function followPageRedirects(
  url: PageUrl,
  signal: AbortSignal,
  dependencies: PageRequestDependencies
): Promise<PageRequestResult> {
  let currentUrl = url
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await openPageResponse(currentUrl, signal, dependencies)
    const location = findRedirectLocation(response)
    if (location === undefined) return readPageResponse(currentUrl, response)
    response.destroy()
    if (redirectCount === MAXIMUM_PAGE_REDIRECTS) {
      return buildFailedPageResult({ kind: "too-many-redirects" })
    }
    const redirect = parseRedirectUrl(location, currentUrl)
    if (redirect.status === "invalid") {
      return buildFailedPageResult({
        kind: "invalid-redirect",
        problem: redirect.problem
      })
    }
    currentUrl = redirect.url
  }
}

/**
 * Answers whether a failure carries a system or TLS error code.
 *
 * @param error - Untrusted failure.
 * @returns True for an `Error` whose `code` is a non-empty string.
 */
function hasErrorCode(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code !== ""
  )
}

/**
 * Finds the recognized failure a request failure stands for.
 *
 * @param error - Failure the request rejected with, while it was neither
 * stopped nor timed out.
 * @returns The failure, or undefined when the failure is not recognized.
 */
function findPageRequestFailure(
  error: unknown
): PageRequestFailure | undefined {
  if (error instanceof PageRequestFailureError) return error.failure
  if (hasErrorCode(error)) {
    return Object.freeze({ kind: "transfer-failed", code: error.code })
  }
  return undefined
}

/**
 * Gets one web page: requests it, follows redirects that pass the page URL
 * rules, and reads its body as text.
 *
 * @param url - Checked page URL.
 * @param abortSignal - Stops the request; borrowed for the call.
 * @param dependencies - Lookup, address rule, and time limit.
 * @returns The page, or why it cannot be read: a blocked or missing address,
 * a redirect Lys may not follow or too many redirects, a timeout, a failed
 * connection or a body that cannot be decompressed, a status other than
 * 2xx, or a body that is not HTML or plain text or uses an unsupported
 * compression.
 * @throws The abort reason once `abortSignal` aborts, and any failure Lys
 * does not recognize unchanged.
 * @remarks Every connection goes to an address that passed the address
 * rule, checked again on the connected socket. At most
 * {@link MAXIMUM_PAGE_REDIRECTS} redirects are followed, each target checked
 * like the first URL. The body is decompressed and read up to
 * {@link MAXIMUM_PAGE_BODY_BYTES}. The time limit covers the whole request.
 * No cookie is kept between requests, and every request opens its own
 * connections.
 */
export async function getWebPage(
  url: PageUrl,
  abortSignal: AbortSignal,
  dependencies: PageRequestDependencies
): Promise<PageRequestResult> {
  const timeoutSignal = AbortSignal.timeout(dependencies.requestTimeoutMs)
  const requestSignal = AbortSignal.any([abortSignal, timeoutSignal])
  try {
    return await followPageRedirects(url, requestSignal, dependencies)
  } catch (error) {
    if (abortSignal.aborted) throw abortSignal.reason
    if (timeoutSignal.aborted) {
      return buildFailedPageResult({ kind: "timed-out" })
    }
    const failure = findPageRequestFailure(error)
    if (failure === undefined) throw error
    return buildFailedPageResult(failure)
  }
}
