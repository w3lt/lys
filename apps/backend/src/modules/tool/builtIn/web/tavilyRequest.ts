import type { TavilyApiKey } from "@lys/share"
import { request as requestHttp, type IncomingMessage } from "node:http"
import { request as requestHttps, type RequestOptions } from "node:https"
import type { Socket } from "node:net"
import type { Readable } from "node:stream"
import {
  ConnectionAddressError,
  createCheckedLookup,
  hasErrorCode,
  LYS_USER_AGENT,
  parseResponseChunk,
  watchConnectedAddress,
  type ConnectionAddressRule
} from "./webConnection"

/** Most bytes of one Tavily response body, inclusive. */
export const MAXIMUM_TAVILY_RESPONSE_BYTES = 1024 * 1024

/** What one Tavily request needs from its environment. */
export type TavilyRequestDependencies = ConnectionAddressRule &
  Readonly<{
    /**
     * Origin every request goes to, without a trailing slash:
     * `https://api.tavily.com` in production. Tests use a loopback `http:`
     * origin.
     */
    origin: string
    /**
     * Most milliseconds one request may take, connection and body included;
     * a positive integer.
     */
    requestTimeoutMs: number
  }>

/** One request to the Tavily API. */
export type TavilyRequest =
  | Readonly<{
      /** A request without a body. */
      method: "GET"
      /** API path. */
      path: "/usage"
      /** Key sent in the `authorization` header; a secret. */
      apiKey: TavilyApiKey
    }>
  | Readonly<{
      /** A request with a JSON body. */
      method: "POST"
      /** API path. */
      path: "/search"
      /** Key sent in the `authorization` header; a secret. */
      apiKey: TavilyApiKey
      /** JSON text of the body. */
      body: string
    }>

/** Why a Tavily request did not give a JSON answer. */
export type TavilyRequestFailure =
  | Readonly<{
      /** The host resolved to, or the socket reached, a blocked address. */
      kind: "blocked-address"
    }>
  | Readonly<{
      /** The host name has no address. */
      kind: "unresolvable-host"
    }>
  | Readonly<{
      /** The connection or TLS failed, or broke while the body arrived. */
      kind: "unreachable"
      /** System or TLS error code, such as `ECONNREFUSED`. */
      code: string
    }>
  | Readonly<{
      /** The request took longer than its time limit. */
      kind: "timed-out"
    }>
  | Readonly<{
      /** Tavily answered with a redirect, which is never followed. */
      kind: "redirected"
    }>
  | Readonly<{
      /** Tavily answered with a status other than 2xx or 3xx. */
      kind: "http-status"
      /** HTTP status code. */
      status: number
      /**
       * Seconds Tavily asked to wait, from a `Retry-After` header given in
       * seconds; undefined when there is none or it is a date.
       */
      retryAfterSeconds: number | undefined
    }>
  | Readonly<{
      /** The body was longer than {@link MAXIMUM_TAVILY_RESPONSE_BYTES}. */
      kind: "too-large"
    }>
  | Readonly<{
      /**
       * The body is not `application/json` in UTF-8 without compression, or
       * not valid JSON.
       */
      kind: "unreadable"
    }>

/** Outcome of one Tavily request. */
export type TavilyRequestResult =
  | Readonly<{
      /** Tavily answered 2xx with a JSON body. */
      status: "succeeded"
      /** Parsed JSON body; untrusted until its schema accepts it. */
      body: unknown
    }>
  | Readonly<{
      /** No JSON answer. */
      status: "failed"
      /** Why. */
      failure: TavilyRequestFailure
    }>

/** Outcome of reading a body within the size limit. */
type BoundedBody =
  | Readonly<{
      /** The whole body fit. */
      status: "read"
      /** Its bytes. */
      bytes: Uint8Array
    }>
  | Readonly<{
      /** The body was longer than the limit; reading stopped. */
      status: "too-large"
    }>

/** Decoder that rejects bytes that are not UTF-8. */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

/** Finds a `Retry-After` value given in whole seconds. */
const RETRY_AFTER_SECONDS_PATTERN = /^\d{1,6}$/

/** Failure of a request that ran out of time. */
const TIMED_OUT: TavilyRequestFailure = Object.freeze({ kind: "timed-out" })

/** Failure of a response that redirects. */
const REDIRECTED: TavilyRequestFailure = Object.freeze({ kind: "redirected" })

/** Failure of a body that cannot be read as JSON. */
const UNREADABLE: TavilyRequestFailure = Object.freeze({ kind: "unreadable" })

/** Failure of a body over the size limit. */
const TOO_LARGE: TavilyRequestFailure = Object.freeze({ kind: "too-large" })

/** Body outcome of a body over the size limit. */
const TOO_LARGE_BODY: BoundedBody = Object.freeze({ status: "too-large" })

/**
 * Builds a failed outcome.
 *
 * @param failure - Why the request gave no JSON answer.
 * @returns A frozen failed result.
 */
function buildFailedResult(failure: TavilyRequestFailure): TavilyRequestResult {
  return Object.freeze({ status: "failed", failure })
}

/**
 * Builds the headers of one request.
 *
 * @param request - Request whose key and body the headers describe.
 * @returns Frozen headers: the key as a bearer token, JSON accepted without
 * compression, and Lys's user agent; a POST adds its content type and
 * length. No cookie, referrer, or other credential is ever sent.
 */
function buildTavilyHeaders(
  request: TavilyRequest
): Readonly<Record<string, string>> {
  const authorization = `Bearer ${request.apiKey}`
  switch (request.method) {
    case "GET":
      return Object.freeze({
        authorization,
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": LYS_USER_AGENT
      })
    case "POST":
      return Object.freeze({
        authorization,
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": LYS_USER_AGENT,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(request.body))
      })
  }
}

/**
 * Sends one request and waits for its response headers.
 *
 * @param request - Request to send.
 * @param signal - Aborts the request on Stop or when its time is up.
 * @param dependencies - Origin and address rule.
 * @returns The response, whose body the caller owns and must consume or
 * destroy.
 * @throws The request's failure, including a {@link ConnectionAddressError}.
 * @remarks Certificate verification is forced on and TLS 1.2 is the minimum,
 * whatever the environment says. Each request opens its own connection, to an
 * address checked at lookup and again on the connected socket.
 */
function openTavilyResponse(
  request: TavilyRequest,
  signal: AbortSignal,
  dependencies: TavilyRequestDependencies
): Promise<IncomingMessage> {
  const target = new URL(request.path, dependencies.origin)
  const sendRequest = target.protocol === "https:" ? requestHttps : requestHttp
  const options: RequestOptions = {
    method: request.method,
    headers: buildTavilyHeaders(request),
    agent: false,
    lookup: createCheckedLookup(dependencies),
    signal,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2"
  }
  return new Promise((resolve, reject) => {
    const outgoing = sendRequest(target, options, resolve)
    // Stays attached: a failure after the response arrived, such as the
    // socket closing when the body is destroyed, must not go unhandled. The
    // promise is settled by then, so rejecting again changes nothing.
    outgoing.on("error", reject)
    outgoing.once("socket", (socket: Socket) =>
      watchConnectedAddress(socket, dependencies.isBlockedAddress)
    )
    outgoing.end(request.method === "POST" ? request.body : undefined)
  })
}

/**
 * Parses a `Retry-After` header given in seconds.
 *
 * @param header - Header text, or undefined when there is none.
 * @returns The whole number of seconds, or undefined for a missing header or
 * one given as a date.
 */
function parseRetryAfterSeconds(
  header: string | undefined
): number | undefined {
  const value = header?.trim()
  if (value === undefined || !RETRY_AFTER_SECONDS_PATTERN.test(value)) {
    return undefined
  }
  return Number(value)
}

/**
 * Finds why a response's status rules out a JSON answer.
 *
 * @param response - Response whose headers arrived.
 * @returns `redirected` for 3xx, `http-status` for any other status outside
 * 2xx, or undefined for 2xx.
 */
function findTavilyStatusFailure(
  response: IncomingMessage
): TavilyRequestFailure | undefined {
  const status = response.statusCode ?? 0
  if (status >= 200 && status <= 299) return undefined
  if (status >= 300 && status <= 399) return REDIRECTED
  const retryAfterSeconds = parseRetryAfterSeconds(
    response.headers["retry-after"]
  )
  return Object.freeze({ kind: "http-status", status, retryAfterSeconds })
}

/**
 * Answers whether one `Content-Type` parameter allows UTF-8 JSON.
 *
 * @param parameter - One parameter after the media type.
 * @returns False only for a charset other than UTF-8.
 */
function isUtf8OrOtherParameter(parameter: string): boolean {
  const [name = "", value = ""] = parameter.split("=")
  if (name.trim().toLowerCase() !== "charset") return true
  return value.trim().replace(/^"|"$/g, "").toLowerCase() === "utf-8"
}

/**
 * Answers whether a response says its body is UTF-8 JSON without
 * compression.
 *
 * @param response - Response whose headers arrived.
 * @returns True for `application/json` with no charset or UTF-8, and no
 * content encoding other than `identity`.
 */
function isTavilyJsonResponse(response: IncomingMessage): boolean {
  const [mediaType = "", ...parameters] = (
    response.headers["content-type"] ?? ""
  ).split(";")
  const encoding = (response.headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase()
  if (mediaType.trim().toLowerCase() !== "application/json") return false
  return encoding === "identity" && parameters.every(isUtf8OrOtherParameter)
}

/**
 * Reads a body up to {@link MAXIMUM_TAVILY_RESPONSE_BYTES}.
 *
 * @param body - Body stream; leaving it early destroys it.
 * @returns The bytes, or `too-large` as soon as the body passes the limit.
 * @throws The stream's failure, such as an aborted request.
 */
async function readBoundedBody(body: Readable): Promise<BoundedBody> {
  const chunks: Uint8Array[] = []
  let byteCount = 0
  for await (const chunk of body) {
    const bytes = parseResponseChunk(chunk)
    const nextByteCount = byteCount + bytes.byteLength
    if (nextByteCount > MAXIMUM_TAVILY_RESPONSE_BYTES) return TOO_LARGE_BODY
    chunks.push(bytes)
    byteCount = nextByteCount
  }
  return Object.freeze({ status: "read", bytes: Buffer.concat(chunks) })
}

/**
 * Parses body bytes as UTF-8 JSON.
 *
 * @param bytes - Whole body.
 * @returns `succeeded` with the parsed value, or `unreadable`.
 * @remarks A decoding or parse failure is dropped, never kept, because its
 * message can quote the body.
 */
function parseJsonBody(bytes: Uint8Array): TavilyRequestResult {
  try {
    const body: unknown = JSON.parse(UTF8_DECODER.decode(bytes))
    return Object.freeze({ status: "succeeded", body })
  } catch {
    return buildFailedResult(UNREADABLE)
  }
}

/**
 * Reads a response into a JSON answer.
 *
 * @param response - Response whose headers arrived; it is destroyed before
 * this settles.
 * @returns The answer, or why there is none.
 * @throws A body read failure.
 */
async function readTavilyResponse(
  response: IncomingMessage
): Promise<TavilyRequestResult> {
  try {
    const statusFailure = findTavilyStatusFailure(response)
    if (statusFailure !== undefined) return buildFailedResult(statusFailure)
    if (!isTavilyJsonResponse(response)) return buildFailedResult(UNREADABLE)
    const body = await readBoundedBody(response)
    if (body.status === "too-large") return buildFailedResult(TOO_LARGE)
    return parseJsonBody(body.bytes)
  } finally {
    response.destroy()
  }
}

/**
 * Finds the recognized failure a request failure stands for.
 *
 * @param error - Failure the request rejected with, while it was neither
 * stopped nor timed out.
 * @returns The failure, or undefined when it is not recognized.
 */
function findTavilyRequestFailure(
  error: unknown
): TavilyRequestFailure | undefined {
  if (error instanceof ConnectionAddressError) {
    return Object.freeze({ kind: error.kind })
  }
  if (hasErrorCode(error)) {
    return Object.freeze({ kind: "unreachable", code: error.code })
  }
  return undefined
}

/**
 * Sends one request to the Tavily API and reads its JSON answer.
 *
 * @param request - Request to send; its key goes only into the
 * `authorization` header.
 * @param abortSignal - Stops the request; borrowed for the call.
 * @param dependencies - Origin, address rule, and time limit.
 * @returns The parsed JSON of a 2xx answer, or why there is none.
 * @throws The abort reason once `abortSignal` aborts, and any failure Lys
 * does not recognize unchanged.
 * @remarks The time limit covers the connection and the whole body. No
 * redirect is followed, no body larger than
 * {@link MAXIMUM_TAVILY_RESPONSE_BYTES} is read, and a non-2xx body is
 * never read. Nothing in a result or a recognized failure holds the key or
 * Tavily's text.
 */
export async function sendTavilyRequest(
  request: TavilyRequest,
  abortSignal: AbortSignal,
  dependencies: TavilyRequestDependencies
): Promise<TavilyRequestResult> {
  abortSignal.throwIfAborted()
  const timeoutSignal = AbortSignal.timeout(dependencies.requestTimeoutMs)
  const requestSignal = AbortSignal.any([abortSignal, timeoutSignal])
  try {
    const response = await openTavilyResponse(
      request,
      requestSignal,
      dependencies
    )
    return await readTavilyResponse(response)
  } catch (error) {
    if (abortSignal.aborted) throw abortSignal.reason
    if (timeoutSignal.aborted) return buildFailedResult(TIMED_OUT)
    const failure = findTavilyRequestFailure(error)
    if (failure === undefined) throw error
    return buildFailedResult(failure)
  }
}
