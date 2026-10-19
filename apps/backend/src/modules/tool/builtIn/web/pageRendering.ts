import type { IncomingMessage } from "node:http"
import { isIP } from "node:net"
import * as z from "zod"
import { waitForSettlementOrAbort } from "../../../../utils/abort"
import type { PageUrl } from "./pageUrl"
import { formatCutText } from "./untrustedText"
import { openVmoResponse } from "./vmoRequest"
import {
  ConnectionAddressError,
  hasErrorCode,
  isJsonResponse,
  listCheckedHostAddresses,
  parseJsonBody,
  readBoundedBody,
  type ConnectionAddressRule
} from "./webConnection"

/**
 * Most UTF-16 code units of a page's HTML Lys reads, inclusive. Longer HTML
 * is cut, so only its beginning is read.
 */
export const MAXIMUM_PAGE_HTML_LENGTH = 4 * 1024 * 1024

/**
 * Most bytes of one answer from vmo that Lys reads, inclusive; it bounds the
 * memory one read takes. HTML of {@link MAXIMUM_PAGE_HTML_LENGTH} code units
 * takes at most 12 MiB as UTF-8, which leaves 4 MiB for what JSON escapes, so
 * such HTML fits unless it is mostly quotes, slashes, or control characters.
 * A page whose answer is longer fails as `too-large`; a shorter answer with
 * longer HTML is read and cut.
 */
export const MAXIMUM_VMO_RESPONSE_BYTES = 16 * 1024 * 1024

/** A page vmo read. */
export type RenderedPage = Readonly<{
  /**
   * URL Lys asked vmo to read. vmo does not say where the page's redirects
   * led, so this is never the URL a redirect reached.
   */
  url: PageUrl
  /**
   * HTML of the page's DOM once it rendered, without scripts, styles,
   * `<noscript>`, `<link>`, `<meta>`, or `class` and `style` attributes; at
   * most {@link MAXIMUM_PAGE_HTML_LENGTH} code units.
   */
  html: string
  /**
   * Whether the page's HTML was longer than Lys's or vmo's limit and only its
   * beginning was read.
   */
  isTruncated: boolean
}>

/** Receives the causes of read failures the model is told about only by kind. */
export type PageRenderingFailureReporters = Readonly<{
  /**
   * Receives why vmo could not be reached, gave an answer Lys does not
   * understand, or did not answer in time; the read then fails as
   * `reader-unreachable`, `reader-failed`, or `reader-timed-out`.
   */
  reportPageReaderFailure: (failure: unknown) => void
}>

/** What one read through vmo needs from its environment. */
export type PageRenderingDependencies = ConnectionAddressRule &
  PageRenderingFailureReporters &
  Readonly<{
    /**
     * Origin of vmo, without a trailing slash: `http://127.0.0.1:8080` in
     * production. Tests use a loopback origin of their own.
     */
    vmoOrigin: string
    /**
     * Most milliseconds the whole read may take, the host lookup and vmo's
     * whole answer included; a positive integer.
     */
    readTimeoutMs: number
  }>

/** Why a page could not be read through vmo. */
export type PageRenderingFailure =
  | Readonly<{
      /**
       * The page's host is a name that resolves to this machine or a private
       * network, so vmo was not asked.
       */
      kind: "blocked-address"
    }>
  | Readonly<{
      /** The page's host name has no address, so vmo was not asked. */
      kind: "unresolvable-host"
    }>
  | Readonly<{
      /**
       * vmo refused the page's URL: it does not parse it as a page URL, or
       * the request that names it is too long.
       */
      kind: "url-refused"
    }>
  | Readonly<{
      /** The page did not load within vmo's own time limit. */
      kind: "timed-out"
    }>
  | Readonly<{
      /**
       * The browser in vmo's micro VM could not load the page, or the page
       * was empty.
       */
      kind: "not-loaded"
    }>
  | Readonly<{
      /** vmo's answer is longer than {@link MAXIMUM_VMO_RESPONSE_BYTES}. */
      kind: "too-large"
    }>
  | Readonly<{
      /** vmo is not listening, or its connection broke. */
      kind: "reader-unreachable"
    }>
  | Readonly<{
      /**
       * vmo failed, or answered with a status, media type, or body its
       * contract does not have.
       */
      kind: "reader-failed"
    }>
  | Readonly<{
      /** The whole read did not end within its time limit. */
      kind: "reader-timed-out"
    }>

/** Outcome of one read through vmo. */
export type PageRenderingResult =
  | Readonly<{
      /** The page was read. */
      status: "rendered"
      /** What vmo read. */
      page: RenderedPage
    }>
  | FailedRendering

/** A failed outcome. */
type FailedRendering = Readonly<{
  /** The page could not be read. */
  status: "failed"
  /** Why. */
  failure: PageRenderingFailure
}>

/** Validates vmo's `200 OK` answer to a page read, before Lys trusts it. */
const vmoReadPageAnswerSchema = z
  .strictObject({
    /** HTML the page's reader wrote, as vmo decoded it from UTF-8. */
    html: z.string(),
    /** Whether vmo kept only the beginning of what the reader wrote. */
    isTruncated: z.boolean()
  })
  .readonly()

/** vmo's answer to a page it read. */
type VmoReadPageAnswer = z.infer<typeof vmoReadPageAnswerSchema>

/** Path of vmo's read-page route. */
const VMO_READ_PAGE_PATH = "/web/read-page"

/** Headers of every read sent to vmo: JSON accepted, without compression. */
const VMO_READ_PAGE_REQUEST_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    accept: "application/json",
    "accept-encoding": "identity"
  })

/** Failure of a URL vmo refused. */
const URL_REFUSED: PageRenderingFailure = Object.freeze({ kind: "url-refused" })

/** Failure of a page that did not load within vmo's time limit. */
const TIMED_OUT: PageRenderingFailure = Object.freeze({ kind: "timed-out" })

/** Failure of a page the browser could not load. */
const NOT_LOADED: PageRenderingFailure = Object.freeze({ kind: "not-loaded" })

/** Failure of an answer over the size limit. */
const TOO_LARGE: PageRenderingFailure = Object.freeze({ kind: "too-large" })

/** Failure of a vmo that cannot be reached. */
const READER_UNREACHABLE: PageRenderingFailure = Object.freeze({
  kind: "reader-unreachable"
})

/** Failure of a vmo that failed or broke its contract. */
const READER_FAILED: PageRenderingFailure = Object.freeze({
  kind: "reader-failed"
})

/** Failure of a read that ran out of its time limit. */
const READER_TIMED_OUT: PageRenderingFailure = Object.freeze({
  kind: "reader-timed-out"
})

/**
 * Builds a failed outcome.
 *
 * @param failure - Why the page could not be read.
 * @returns A frozen failed result.
 */
function buildFailedRendering(failure: PageRenderingFailure): FailedRendering {
  return Object.freeze({ status: "failed", failure })
}

/**
 * Finds why the page's host name may not be read.
 *
 * @param url - Page to read.
 * @param rule - Lookup and address rule.
 * @returns `blocked-address` when any address of the host name is blocked,
 * `unresolvable-host` when it has none, or undefined when vmo may be asked.
 * A host that is an IP address is not looked up: the page URL rules already
 * refused a blocked one.
 * @throws A lookup failure without a system code, unchanged.
 */
async function findHostAddressFailure(
  url: PageUrl,
  rule: ConnectionAddressRule
): Promise<PageRenderingFailure | undefined> {
  const { hostname } = new URL(url)
  if (hostname.startsWith("[") || isIP(hostname) !== 0) return undefined
  try {
    await listCheckedHostAddresses(hostname, rule)
    return undefined
  } catch (error) {
    if (!(error instanceof ConnectionAddressError)) throw error
    return Object.freeze({ kind: error.kind })
  }
}

/**
 * Builds the URL of vmo's read of one page.
 *
 * @param url - Page to read.
 * @param vmoOrigin - Origin of vmo.
 * @returns vmo's read-page route with the page's URL as its `url` query
 * parameter, form-encoded as vmo decodes it.
 */
function buildVmoReadPageUrl(url: PageUrl, vmoOrigin: string): URL {
  const target = new URL(VMO_READ_PAGE_PATH, vmoOrigin)
  target.searchParams.set("url", url)
  return target
}

/**
 * Finds the read failure a status of vmo stands for.
 *
 * @param status - HTTP status of vmo's answer, other than 200.
 * @returns `url-refused` for 400, which vmo gives a URL it does not parse,
 * and 431, which it gives a request too long to read; `not-loaded` for 502,
 * which it gives when the page's reader exits with an error; `timed-out` for
 * 504, which it gives when its time limit passes; undefined for any other
 * status.
 */
function findVmoStatusFailure(
  status: number
): PageRenderingFailure | undefined {
  switch (status) {
    case 400:
    case 431:
      return URL_REFUSED
    case 502:
      return NOT_LOADED
    case 504:
      return TIMED_OUT
    default:
      return undefined
  }
}

/**
 * Handles an answer of vmo that its contract does not have: reports its
 * cause and fails the read.
 *
 * @param cause - What was wrong with the answer, without any of its body.
 * @param dependencies - Failure reporter.
 * @returns `reader-failed`.
 */
function handleUnexpectedVmoAnswer(
  cause: Error,
  dependencies: PageRenderingDependencies
): FailedRendering {
  dependencies.reportPageReaderFailure(cause)
  return buildFailedRendering(READER_FAILED)
}

/**
 * Builds the outcome of a page vmo read.
 *
 * @param url - Page Lys asked vmo to read.
 * @param answer - vmo's validated answer.
 * @returns The page, its HTML cut to {@link MAXIMUM_PAGE_HTML_LENGTH} without
 * splitting a character, truncated when vmo or Lys cut it.
 */
function buildRenderedResult(
  url: PageUrl,
  answer: VmoReadPageAnswer
): PageRenderingResult {
  const html = formatCutText(answer.html, MAXIMUM_PAGE_HTML_LENGTH)
  const page: RenderedPage = Object.freeze({
    url,
    html,
    isTruncated: answer.isTruncated || html.length < answer.html.length
  })
  return Object.freeze({ status: "rendered", page })
}

/**
 * Reads vmo's `200 OK` answer into the page.
 *
 * @param response - Response whose status is 200.
 * @param url - Page Lys asked vmo to read.
 * @param dependencies - Failure reporter.
 * @returns The page; `too-large` for a body over
 * {@link MAXIMUM_VMO_RESPONSE_BYTES}; `reader-failed`, reported, for a body
 * that is not UTF-8 JSON or does not match vmo's answer.
 * @throws A body read failure.
 */
async function readVmoPage(
  response: IncomingMessage,
  url: PageUrl,
  dependencies: PageRenderingDependencies
): Promise<PageRenderingResult> {
  if (!isJsonResponse(response)) {
    return handleUnexpectedVmoAnswer(
      new Error("vmo answered a page read with a body that is not JSON"),
      dependencies
    )
  }
  const body = await readBoundedBody(response, MAXIMUM_VMO_RESPONSE_BYTES)
  if (body.status === "too-large") return buildFailedRendering(TOO_LARGE)
  const json = parseJsonBody(body.bytes)
  const answer =
    json.status === "parsed"
      ? vmoReadPageAnswerSchema.safeParse(json.value)
      : undefined
  if (answer?.success !== true) {
    return handleUnexpectedVmoAnswer(
      new Error("vmo's answer to a page read is not the JSON it promises", {
        cause: answer?.error
      }),
      dependencies
    )
  }
  return buildRenderedResult(url, answer.data)
}

/**
 * Reads vmo's answer to one read.
 *
 * @param response - Response whose headers arrived; it is destroyed before
 * this settles.
 * @param url - Page Lys asked vmo to read.
 * @param dependencies - Failure reporter.
 * @returns The page for 200; the failure a status of vmo stands for; or
 * `reader-failed`, reported, for any other status. Only a 200 body is read.
 * @throws A body read failure.
 */
async function readVmoResponse(
  response: IncomingMessage,
  url: PageUrl,
  dependencies: PageRenderingDependencies
): Promise<PageRenderingResult> {
  try {
    const status = response.statusCode ?? 0
    if (status === 200) return await readVmoPage(response, url, dependencies)
    const failure = findVmoStatusFailure(status)
    if (failure !== undefined) return buildFailedRendering(failure)
    return handleUnexpectedVmoAnswer(
      new Error(`vmo answered a page read with HTTP status ${status}`),
      dependencies
    )
  } finally {
    response.destroy()
  }
}

/**
 * Answers whether a read failed because its time limit passed.
 *
 * @param error - Failure of the read.
 * @param timeoutSignal - Time limit of the read.
 * @returns True once the time limit has passed when the failure is its
 * reason, as the wait for the host check rejects, or an error whose `cause`
 * is that reason, as the request to vmo and the read of its answer reject.
 * False for any other failure, even one that arrives after the limit.
 */
function isCausedByTimeout(
  error: unknown,
  timeoutSignal: AbortSignal
): boolean {
  if (!timeoutSignal.aborted) return false
  const reason: unknown = timeoutSignal.reason
  return error === reason || (error instanceof Error && error.cause === reason)
}

/**
 * Handles a failed step of a read that was not stopped: reports the failure
 * and fails the read with its kind.
 *
 * @param error - Failure of the host check's wait, of the request to vmo, or
 * of the read of its answer.
 * @param timeoutSignal - Time limit of the read.
 * @param reporters - Failure reporter.
 * @returns `reader-timed-out`, reported with the time limit's reason, when
 * the time limit caused the failure; otherwise `reader-unreachable`,
 * reported, for a failure with a Node.js error code, as a refused or broken
 * connection has.
 * @throws The failure unchanged when it is neither, which is a defect.
 */
function handleFailedReadStep(
  error: unknown,
  timeoutSignal: AbortSignal,
  reporters: PageRenderingFailureReporters
): FailedRendering {
  if (isCausedByTimeout(error, timeoutSignal)) {
    reporters.reportPageReaderFailure(timeoutSignal.reason)
    return buildFailedRendering(READER_TIMED_OUT)
  }
  if (!hasErrorCode(error)) throw error
  reporters.reportPageReaderFailure(error)
  return buildFailedRendering(READER_UNREACHABLE)
}

/**
 * Reads one page through vmo, which loads it in a fresh micro VM.
 *
 * @param url - Page to read, checked by the page URL rules.
 * @param abortSignal - Stops the read.
 * @param dependencies - vmo's origin, address rule, failure reporter, and
 * time limit.
 * @returns The page's HTML, under the URL Lys asked for; or why the page
 * could not be read.
 * @throws The stop reason once `abortSignal` aborts; nothing is started when
 * it already has. Any failure Lys does not recognize, which is a defect, such
 * as a `vmoOrigin` that is not an `http` URL.
 * @remarks First looks up the page's host name and refuses it when any of its
 * addresses is blocked. That check covers only the URL given: the page's
 * redirects, the resources it loads, and a name that resolves differently
 * inside the micro VM are not checked. Then sends `GET /web/read-page` to
 * vmo, which loads the page in headless Chromium in a micro VM of its own,
 * with the page's scripts running and its redirects followed, for at most
 * vmo's own time limit, and deletes the VM before it answers. The time limit
 * covers the lookup and vmo's whole answer, whose body is bounded by
 * {@link MAXIMUM_VMO_RESPONSE_BYTES}. Stop or the time limit only ends Lys's
 * request: vmo does not notice, and its VM runs until vmo's own time limit
 * ends it.
 */
export async function getRenderedPage(
  url: PageUrl,
  abortSignal: AbortSignal,
  dependencies: PageRenderingDependencies
): Promise<PageRenderingResult> {
  abortSignal.throwIfAborted()
  const target = buildVmoReadPageUrl(url, dependencies.vmoOrigin)
  const timeoutSignal = AbortSignal.timeout(dependencies.readTimeoutMs)
  const readSignal = AbortSignal.any([abortSignal, timeoutSignal])
  try {
    const addressFailure = await waitForSettlementOrAbort(
      findHostAddressFailure(url, dependencies),
      readSignal
    )
    if (addressFailure !== undefined)
      return buildFailedRendering(addressFailure)
  } catch (error) {
    if (abortSignal.aborted) throw abortSignal.reason
    return handleFailedReadStep(error, timeoutSignal, dependencies)
  }
  // Created outside the catch below: Node throws here, before sending, when
  // it cannot build the request, which is a defect, not a failed read.
  const opening = openVmoResponse(
    target,
    VMO_READ_PAGE_REQUEST_HEADERS,
    readSignal
  )
  try {
    return await readVmoResponse(await opening, url, dependencies)
  } catch (error) {
    if (abortSignal.aborted) throw abortSignal.reason
    return handleFailedReadStep(error, timeoutSignal, dependencies)
  }
}
