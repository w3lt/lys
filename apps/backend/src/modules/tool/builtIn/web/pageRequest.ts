import {
  request as requestHttp,
  type IncomingMessage,
  type RequestOptions
} from "node:http"
import { request as requestHttps } from "node:https"
import type { Socket } from "node:net"
import type { Readable, Transform } from "node:stream"
import { createBrotliDecompress, createGunzip } from "node:zlib"
import { decodePageText, type PageMediaType } from "./pageCharset"
import {
  parsePageUrl,
  type PageUrl,
  type PageUrlProblem,
  type PageUrlResult
} from "./pageUrl"
import {
  ConnectionAddressError,
  createCheckedLookup,
  hasErrorCode,
  LYS_USER_AGENT,
  parseResponseChunk,
  watchConnectedAddress,
  type ConnectionAddressRule
} from "./webConnection"

/** What one page request needs from its environment. */
export type PageRequestDependencies = ConnectionAddressRule &
  Readonly<{
    /**
     * Most milliseconds the whole request may take, connection and body
     * included; a positive integer.
     */
    requestTimeoutMs: number
  }>

/** A page body Lys read. */
export type PageResponse = Readonly<{
  /** URL the body came from, which is the URL requested. */
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
      /**
       * The page redirects to a URL that passes the page URL rules. Lys
       * follows no redirect, so the target is not requested.
       */
      kind: "redirected"
      /** Where the page redirects to. */
      location: PageUrl
    }>
  | Readonly<{
      /** The page redirects somewhere Lys may not request. */
      kind: "invalid-redirect"
      /** Why the redirect target may not be requested. */
      problem: PageUrlProblem
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

/** Most decompressed body bytes read from one page, inclusive. */
export const MAXIMUM_PAGE_BODY_BYTES = 4 * 1024 * 1024

/** Status codes that redirect to the URL their `Location` header names. */
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
 * sites already expect from automated readers. Only gzip and Brotli are
 * accepted, because servers send `deflate` in two incompatible forms. No
 * cookie or credential is ever sent.
 */
const PAGE_REQUEST_HEADERS = Object.freeze({
  "user-agent": LYS_USER_AGENT,
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
  "accept-encoding": "gzip, br"
})

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
 * Sends one GET request and waits for its response headers.
 *
 * @param url - Checked page URL.
 * @param signal - Aborts the request on Stop or when its time is up.
 * @param dependencies - Lookup and address rule.
 * @returns The response, whose body the caller owns and must consume or
 * destroy.
 * @throws The request's failure, including a {@link ConnectionAddressError}
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
    lookup: createCheckedLookup(dependencies),
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
    case "br":
      return pipeDecompressedBody(response, createBrotliDecompress())
    default:
      return Object.freeze({ unsupportedEncoding: encoding })
  }
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
    const bytes = parseResponseChunk(chunk)
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
 * Builds the outcome of a response that redirects.
 *
 * @param location - `Location` header text, possibly relative.
 * @param baseUrl - URL of the response that redirected.
 * @returns A failed result: `redirected` with the target when it passes the
 * page URL rules, and `invalid-redirect` with the problem otherwise.
 */
function buildRedirectResult(
  location: string,
  baseUrl: PageUrl
): PageRequestResult {
  const redirect = parseRedirectUrl(location, baseUrl)
  switch (redirect.status) {
    case "valid":
      return buildFailedPageResult({
        kind: "redirected",
        location: redirect.url
      })
    case "invalid":
      return buildFailedPageResult({
        kind: "invalid-redirect",
        problem: redirect.problem
      })
  }
}

/**
 * Sends one page request, without following a redirect.
 *
 * @param url - Checked page URL.
 * @param signal - Aborts the request on Stop or when its time is up.
 * @param dependencies - Lookup and address rule.
 * @returns The page, where it redirects to, or why it cannot be read.
 * @throws A request or body failure, including a
 * {@link ConnectionAddressError}.
 */
async function sendPageRequest(
  url: PageUrl,
  signal: AbortSignal,
  dependencies: PageRequestDependencies
): Promise<PageRequestResult> {
  const response = await openPageResponse(url, signal, dependencies)
  const location = findRedirectLocation(response)
  if (location === undefined) return readPageResponse(url, response)
  response.destroy()
  return buildRedirectResult(location, url)
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
  if (error instanceof ConnectionAddressError) {
    return Object.freeze({ kind: error.kind })
  }
  if (hasErrorCode(error)) {
    return Object.freeze({ kind: "transfer-failed", code: error.code })
  }
  return undefined
}

/**
 * Gets one web page: requests it and reads its body as text.
 *
 * @param url - Checked page URL.
 * @param abortSignal - Stops the request; borrowed for the call.
 * @param dependencies - Lookup, address rule, and time limit.
 * @returns The page, or why it cannot be read: a blocked or missing address,
 * a redirect, which names its target when that passes the page URL rules, a
 * timeout, a failed connection or a body that cannot be decompressed, a
 * status other than 2xx, or a body that is not HTML or plain text or uses
 * an unsupported compression.
 * @throws The abort reason once `abortSignal` aborts, and any failure Lys
 * does not recognize unchanged.
 * @remarks Every connection goes to an address that passed the address
 * rule, checked again on the connected socket. No redirect is followed, so
 * the one request goes only to the URL's host. The body is decompressed and
 * read up to {@link MAXIMUM_PAGE_BODY_BYTES}. The time limit covers the
 * whole request. No cookie is kept between requests, and every request
 * opens its own connections.
 */
export async function getWebPage(
  url: PageUrl,
  abortSignal: AbortSignal,
  dependencies: PageRequestDependencies
): Promise<PageRequestResult> {
  const timeoutSignal = AbortSignal.timeout(dependencies.requestTimeoutMs)
  const requestSignal = AbortSignal.any([abortSignal, timeoutSignal])
  try {
    return await sendPageRequest(url, requestSignal, dependencies)
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
