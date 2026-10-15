import { access, constants as fileConstants } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import {
  chromium,
  errors as playwrightErrors,
  type Browser,
  type LaunchOptions,
  type Page,
  type Request,
  type Response,
  type Route
} from "playwright-core"
import {
  findPageMediaType,
  getPageDocument,
  type PageDocument,
  type PageMediaType
} from "./pageDocument"
import PageProxy, { type PageProxyLimits } from "./pageProxy"
import {
  getUrlPort,
  parsePageUrl,
  type PageUrl,
  type PageUrlProblem
} from "./pageUrl"
import { formatSingleLineText } from "./untrustedText"
import { hasErrorCode, type ConnectionAddressRule } from "./webConnection"

/** A page Lys read in the browser. */
export type RenderedPage = Readonly<{
  /** URL of the page as the browser showed it, after every redirect. */
  url: PageUrl
  /** Whether `text` is HTML or plain text. */
  mediaType: PageMediaType
  /**
   * For HTML, the HTML of the page's DOM once it rendered; for plain text,
   * the page's text.
   */
  text: string
  /**
   * Whether the page was longer than the page text limit and only its
   * beginning was read.
   */
  isTruncated: boolean
}>

/** Receives the causes of read failures the model is told about only by kind. */
export type PageRenderingFailureReporters = Readonly<{
  /**
   * Receives why Lys's browser is missing or could not start; the read then
   * fails as `browser-missing` or `browser-failed`.
   */
  reportBrowserFailure: (failure: unknown) => void
}>

/** What one browser read needs from its environment. */
export type PageRenderingDependencies = ConnectionAddressRule &
  PageRenderingFailureReporters &
  Readonly<{
    /** Absolute path of the Chrome Headless Shell executable. */
    browserExecutablePath: string
    /**
     * Most milliseconds the whole read may take, the browser's start
     * included; a positive integer.
     */
    readTimeoutMs: number
    /**
     * Most milliseconds the read waits, once the page's document has
     * arrived, for its DOM to be ready and its network to go quiet; a
     * positive integer. What has rendered by then is read.
     */
    settleTimeoutMs: number
  }>

/** Why a page could not be read in the browser. */
export type PageRenderingFailure =
  | Readonly<{
      /** The browser's executable does not exist. */
      kind: "browser-missing"
    }>
  | Readonly<{
      /** The browser's executable exists but the browser could not start. */
      kind: "browser-failed"
    }>
  | Readonly<{
      /**
       * The address rule refused the page, or a page it redirected to: it
       * belongs to this machine or a private network.
       */
      kind: "blocked-address"
    }>
  | Readonly<{
      /** The page's host, or a host it redirected to, has no address. */
      kind: "unresolvable-host"
    }>
  | Readonly<{
      /** The read did not finish within its time limit. */
      kind: "timed-out"
    }>
  | Readonly<{
      /** The browser could not load the page's document. */
      kind: "transfer-failed"
      /** Chromium network error, such as `ERR_CONNECTION_REFUSED`. */
      code: string
    }>
  | Readonly<{
      /**
       * The page's document, or the document it went on to, came with a
       * status other than 2xx.
       */
      kind: "http-status"
      /** HTTP status code of the document. */
      status: number
    }>
  | Readonly<{
      /**
       * The page's document, or the document it went on to, is not HTML or
       * plain text.
       */
      kind: "unsupported-content-type"
      /**
       * Media type of the document, cleaned and cut to 100 characters;
       * undefined when the server named none.
       */
      mediaType: string | undefined
    }>
  | Readonly<{
      /** The browser ended on a URL that breaks the page URL rules. */
      kind: "invalid-redirect"
      /** Which rule the URL breaks. */
      problem: PageUrlProblem
    }>
  | Readonly<{
      /** The page crashed the browser while it loaded. */
      kind: "crashed"
    }>

/** Outcome of one browser read. */
export type PageRenderingResult =
  | Readonly<{
      /** The page was read. */
      status: "rendered"
      /** What the browser showed. */
      page: RenderedPage
    }>
  | FailedRendering

/** A failed outcome, which every step's result type includes. */
type FailedRendering = Readonly<{
  /** The page could not be read. */
  status: "failed"
  /** Why. */
  failure: PageRenderingFailure
}>

/** One read in progress, lent to each of its steps. */
type PageRead = Readonly<{
  /** Page to read. */
  url: PageUrl
  /** Stop of the reply; owned by the caller. */
  abortSignal: AbortSignal
  /** Browser, address rule, failure reporters, and time limits. */
  dependencies: PageRenderingDependencies
  /** Proxy the browser's traffic goes through; borrowed from the read. */
  proxy: PageProxy
  /** `performance.now()` value by which the read must end, in milliseconds. */
  deadlineMs: number
}>

/** The one page of a read and what is known about how it loaded. */
type ReadPage = Readonly<{
  /** Page of the read, in the read's browser. */
  page: Page
  /** Last failed navigation of the page's own frame, for the whole read. */
  navigationFailures: FailedNavigationRecorder
  /**
   * Aborts once the page crashes the browser, which a call waiting on the
   * page's renderer would otherwise never learn.
   */
  crashSignal: AbortSignal
}>

/** Why the browser's executable cannot run, and the system error that says so. */
type BrowserExecutableProblem = Readonly<{
  /** `browser-missing` or `browser-failed`. */
  failure: PageRenderingFailure
  /** File system error of the check. */
  cause: NodeJS.ErrnoException
}>

/** Outcome of starting the browser. */
type BrowserStartResult =
  | Readonly<{
      /** The browser started; the read owns it. */
      status: "started"
      /** The started browser. */
      browser: Browser
    }>
  | FailedRendering

/** Outcome of loading the page's document. */
type DocumentLoadResult =
  | Readonly<{
      /** The document loaded. */
      status: "loaded"
      /** Response that delivered it, after every HTTP redirect. */
      response: Response
    }>
  | FailedRendering

/** Whether a loaded document can be read, and how. */
type DocumentReadability =
  | Readonly<{
      /** The document is HTML or plain text with a 2xx status. */
      status: "readable"
      /** How it is read. */
      mediaType: PageMediaType
    }>
  | FailedRendering

/** Most work the proxy accepts for one read. */
const PAGE_PROXY_LIMITS: PageProxyLimits = Object.freeze({
  maximumConnections: 256,
  maximumReceivedBytes: 64 * 1024 * 1024
})

/**
 * Rule of Chromium's proxy bypass list that sends this machine's own
 * addresses through the proxy as well, so the address rule refuses them.
 * Playwright adds it by default but leaves it out when its environment says
 * so; Lys names it itself.
 */
const PROXY_LOOPBACK_RULE = "<-loopback>"

/** Load states the read waits for once the document has arrived, in order. */
const SETTLE_LOAD_STATES = Object.freeze([
  "domcontentloaded",
  "networkidle"
] as const)

/** Scheme of the page Chromium shows when a navigation fails. */
const BROWSER_ERROR_PAGE_SCHEME = "chrome-error:"

/** Milliseconds kept at the end of a read for reading the page's document. */
const DOCUMENT_READ_RESERVE_MS = 2_000

/** Most characters of a media type a failure reports. */
const MAXIMUM_REPORTED_MEDIA_TYPE_LENGTH = 100

/** Lowest HTTP status of a document Lys reads, inclusive. */
const MINIMUM_READABLE_STATUS = 200

/** Highest HTTP status of a document Lys reads, inclusive. */
const MAXIMUM_READABLE_STATUS = 299

/**
 * Most mebibytes a page's scripts may hold, inclusive. A page that holds
 * more crashes its renderer, and the read fails as crashed, instead of
 * growing to the browser's own limit of several gibibytes.
 */
const MAXIMUM_PAGE_SCRIPT_MEMORY_MIB = 1024

/**
 * Chromium arguments of every read: WebRTC may not send UDP around the
 * proxy, no page may open another window, and a page's scripts may hold at
 * most {@link MAXIMUM_PAGE_SCRIPT_MEMORY_MIB}.
 */
const BROWSER_LAUNCH_ARGUMENTS: readonly string[] = Object.freeze([
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--block-new-web-contents",
  `--js-flags=--max-old-space-size=${MAXIMUM_PAGE_SCRIPT_MEMORY_MIB}`
])

/** Resource types that carry no text, so the browser never fetches them. */
const TEXTLESS_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "font",
  "image",
  "media"
])

/** File error codes that mean the browser's executable does not exist. */
const MISSING_FILE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"])

/** Finds the error code in a Chromium network failure, such as `net::ERR_ABORTED`. */
const NETWORK_ERROR_CODE_PATTERN = /^net::(ERR_[A-Z0-9_]+)$/

/** Failure of a read that did not finish within its time limit. */
const TIMED_OUT_FAILURE: PageRenderingFailure = Object.freeze({
  kind: "timed-out"
})

/** Failure of a browser that exists but could not start. */
const BROWSER_FAILED_FAILURE: PageRenderingFailure = Object.freeze({
  kind: "browser-failed"
})

/**
 * Owns the last failed navigation of one page's own frame, recorded from
 * the page's request events, to tell why the page's document did not
 * arrive or why the page ended on the browser's error page.
 *
 * @remarks Invariant: holds the most recent failed navigation request of
 * the page's main frame since it was registered, or none. Its event
 * registration lasts as long as the borrowed page, which closes with the
 * read's browser, so it has no cleanup of its own. Concurrency model:
 * single-owner; Playwright delivers the page's events on the backend's event
 * loop, and only the read that registered it reads it.
 */
class FailedNavigationRecorder {
  /**
   * Last failed navigation of the page's own frame, a borrowed Playwright
   * record; undefined while none has failed.
   */
  #lastFailedNavigation: Request | undefined = undefined

  /** Creates a recorder that has recorded nothing; only `register` does. */
  private constructor() {}

  /**
   * Starts recording the failed navigations of a page.
   *
   * @param page - Page of the read, borrowed; it must stay open while the
   * recorder is read.
   * @returns A recorder whose handler is registered on the page's
   * `requestfailed` event.
   */
  public static register(page: Page): FailedNavigationRecorder {
    const recorder = new FailedNavigationRecorder()
    page.on("requestfailed", (request) =>
      recorder.#handleRequestFailed(request)
    )
    return recorder
  }

  /**
   * Last failed navigation of the page's own frame.
   *
   * @returns The Playwright record of the request, or undefined when none
   * has failed since registration.
   */
  public get lastFailedNavigation(): Request | undefined {
    return this.#lastFailedNavigation
  }

  /**
   * Keeps a failed request when it is a navigation of the page's own frame.
   *
   * @param request - Request that failed.
   */
  #handleRequestFailed(request: Request): void {
    if (!request.isNavigationRequest()) return
    if (request.frame().parentFrame() !== null) return
    this.#lastFailedNavigation = request
  }
}

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
 * Gets the milliseconds left before a read must end.
 *
 * @param read - Read in progress.
 * @returns The whole milliseconds left, at least 0, by the monotonic
 * clock.
 */
function getRemainingTimeMs(read: PageRead): number {
  return Math.max(0, Math.floor(read.deadlineMs - performance.now()))
}

/**
 * Finds why the browser's executable cannot run.
 *
 * @param executablePath - Path of the executable.
 * @returns `browser-missing` when it does not exist, `browser-failed` when
 * it exists but is not executable, each with the error that says so; or
 * undefined when it can run.
 * @throws A failure of the check that carries no system error code.
 */
async function findBrowserExecutableProblem(
  executablePath: string
): Promise<BrowserExecutableProblem | undefined> {
  try {
    await access(executablePath, fileConstants.X_OK)
    return undefined
  } catch (error) {
    if (!hasErrorCode(error)) throw error
    const failure: PageRenderingFailure = Object.freeze({
      kind: MISSING_FILE_CODES.has(error.code)
        ? "browser-missing"
        : "browser-failed"
    })
    return Object.freeze({ failure, cause: error })
  }
}

/**
 * Closes what a step used once the step has settled.
 *
 * @param use - Step that uses the resource.
 * @param close - Closes the resource; called once, after `use` settles.
 * @returns What the step resolved with.
 * @throws What the step rejected with; when closing also fails, an
 * `AggregateError` holding both, the step's failure first. When only
 * closing fails, that failure.
 */
async function closeAfterUse<TResult>(
  use: Promise<TResult>,
  close: () => Promise<void>
): Promise<TResult> {
  const [outcome] = await Promise.allSettled([use])
  try {
    await close()
  } catch (closeError) {
    if (outcome?.status !== "rejected") throw closeError
    throw new AggregateError(
      [outcome.reason, closeError],
      "Reading the page failed, and closing what it used failed too",
      { cause: closeError }
    )
  }
  if (outcome?.status !== "fulfilled") throw outcome?.reason
  return outcome.value
}

/**
 * Waits for a step of a read unless a signal aborts first.
 *
 * @param step - Step in progress.
 * @param signal - Ends the wait; it may already have aborted.
 * @returns What the step resolved with.
 * @throws The signal's reason once it aborts, or the step's failure. A step
 * left behind keeps running until its browser is closed; its later failure
 * is observed and ignored.
 */
async function waitForReadStep<TResult>(
  step: Promise<TResult>,
  signal: AbortSignal
): Promise<TResult> {
  const { promise: stopped, reject } = Promise.withResolvers<never>()
  const rejectStopped = () => reject(signal.reason)
  signal.addEventListener("abort", rejectStopped, { once: true })
  if (signal.aborted) rejectStopped()
  try {
    return await Promise.race([step, stopped])
  } finally {
    signal.removeEventListener("abort", rejectStopped)
  }
}

/**
 * Builds how the browser starts for one read.
 *
 * @param read - Read in progress.
 * @param timeoutMs - Most milliseconds the start may take; a positive
 * integer.
 * @returns Launch options: the executable, headless, Chromium's sandbox on,
 * every request through the read's proxy with its credentials, this
 * machine's own addresses included, and the start timeout.
 */
function buildLaunchOptions(read: PageRead, timeoutMs: number): LaunchOptions {
  const proxy = Object.freeze({
    server: read.proxy.url,
    bypass: PROXY_LOOPBACK_RULE,
    username: read.proxy.credentials.username,
    password: read.proxy.credentials.password
  })
  return {
    executablePath: read.dependencies.browserExecutablePath,
    headless: true,
    chromiumSandbox: true,
    timeout: timeoutMs,
    proxy,
    args: [...BROWSER_LAUNCH_ARGUMENTS]
  }
}

/**
 * Handles a browser start that failed: tells a start that ran out of time
 * from a broken browser, and reports the broken browser's cause.
 *
 * @param error - What the start rejected with.
 * @param read - Read in progress, whose failure reporter receives the cause
 * of a start that failed for any reason other than time.
 * @returns `timed-out` when the start ran out of the read's time;
 * `browser-failed` otherwise.
 */
function handleBrowserStartFailure(
  error: unknown,
  read: PageRead
): FailedRendering {
  if (error instanceof playwrightErrors.TimeoutError) {
    return buildFailedRendering(TIMED_OUT_FAILURE)
  }
  read.dependencies.reportBrowserFailure(error)
  return buildFailedRendering(BROWSER_FAILED_FAILURE)
}

/**
 * Starts the browser of one read.
 *
 * @param read - Read in progress.
 * @returns The started browser, owned by the caller; `timed-out` when no
 * time is left or the start runs out of it; or `browser-failed`.
 * @throws The stop reason when the read was stopped while the browser
 * started; a browser that started anyway is closed first, and when closing
 * it fails, an `AggregateError` holding the stop reason and that failure. A
 * start that failed is still handled, its cause reported, before the stop
 * reason is thrown. Starting cannot be interrupted, so a stop waits for it,
 * at most the read's time limit.
 */
async function startPageBrowser(read: PageRead): Promise<BrowserStartResult> {
  const timeoutMs = getRemainingTimeMs(read)
  if (timeoutMs === 0) return buildFailedRendering(TIMED_OUT_FAILURE)
  const [start] = await Promise.allSettled([
    chromium.launch(buildLaunchOptions(read, timeoutMs))
  ])
  if (start?.status !== "fulfilled") {
    const failure = handleBrowserStartFailure(start?.reason, read)
    read.abortSignal.throwIfAborted()
    return failure
  }
  const browser = start.value
  if (read.abortSignal.aborted) {
    return closeAfterUse(Promise.reject<never>(read.abortSignal.reason), () =>
      browser.close()
    )
  }
  return Object.freeze({ status: "started", browser })
}

/**
 * Lets a request of the page through unless it fetches a resource that
 * carries no text.
 *
 * @param route - Request the page is about to send.
 * @returns A promise that settles once the request is let through or
 * aborted.
 */
function handleResourceRoute(route: Route): Promise<void> {
  return TEXTLESS_RESOURCE_TYPES.has(route.request().resourceType())
    ? route.abort()
    : route.continue()
}

/**
 * Opens the one page of a read in a fresh browser context.
 *
 * @param browser - Browser of the read.
 * @returns A page whose context keeps no service worker and accepts no
 * download, and that never fetches images, fonts, or media, with the
 * failed navigations of its own frame recorded, and its crash watched, from
 * now on.
 */
async function openReadPage(browser: Browser): Promise<ReadPage> {
  const context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: false
  })
  const page = await context.newPage()
  await page.route("**/*", handleResourceRoute)
  const navigationFailures = FailedNavigationRecorder.register(page)
  const crash = new AbortController()
  page.once("crash", () =>
    crash.abort(new Error("The page crashed Lys's browser"))
  )
  return Object.freeze({ page, navigationFailures, crashSignal: crash.signal })
}

/**
 * Finds the media type a `Content-Type` value names.
 *
 * @param contentType - Untrusted header value, or undefined.
 * @returns The lowercase media type, or undefined when it names none.
 */
function parseMediaType(contentType: string | undefined): string | undefined {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase()
  return mediaType === "" ? undefined : mediaType
}

/**
 * Answers whether a document's status lets Lys read it.
 *
 * @param status - HTTP status of the document's response.
 * @returns True for 2xx only. A document a page's script writes, as through
 * a `javascript:` URL, keeps the status of the document that wrote it.
 */
function isReadableStatus(status: number): boolean {
  return status >= MINIMUM_READABLE_STATUS && status <= MAXIMUM_READABLE_STATUS
}

/**
 * Decides whether a document can be read.
 *
 * @param status - HTTP status of the document's response.
 * @param mediaType - Lowercase media type of the document, or undefined
 * when its server named none.
 * @returns How to read it, or why it cannot be read: its status, then its
 * media type, cleaned and cut for the failure.
 */
function parseDocumentReadability(
  status: number,
  mediaType: string | undefined
): DocumentReadability {
  if (!isReadableStatus(status)) {
    return buildFailedRendering(Object.freeze({ kind: "http-status", status }))
  }
  const pageMediaType =
    mediaType === undefined ? undefined : findPageMediaType(mediaType)
  if (pageMediaType !== undefined) {
    return Object.freeze({ status: "readable", mediaType: pageMediaType })
  }
  const reportedMediaType =
    mediaType === undefined
      ? undefined
      : formatSingleLineText(mediaType, MAXIMUM_REPORTED_MEDIA_TYPE_LENGTH)
  return buildFailedRendering(
    Object.freeze({
      kind: "unsupported-content-type",
      mediaType: reportedMediaType
    })
  )
}

/**
 * Decides whether the document a response delivered can be read.
 *
 * @param response - Untrusted response that delivered the document.
 * @returns How to read it, or why it cannot be read: its status or its
 * media type.
 */
function parseDocumentResponse(response: Response): DocumentReadability {
  return parseDocumentReadability(
    response.status(),
    parseMediaType(response.headers()["content-type"])
  )
}

/**
 * Decides why a navigation request of the page failed.
 *
 * @param request - The failed navigation, possibly a redirect's target.
 * @param proxy - Proxy of the read, which knows what it refused.
 * @returns The proxy's refusal of the request's host; else the document's
 * status or media type when its response arrived, as for a download; else
 * the network error.
 * @throws When the failure is not a Chromium network error.
 */
async function parseFailedNavigation(
  request: Request,
  proxy: PageProxy
): Promise<FailedRendering> {
  const target = new URL(request.url())
  const refusal = proxy.findRefusal(target.hostname, getUrlPort(target))
  if (refusal !== undefined) {
    return buildFailedRendering(Object.freeze({ kind: refusal.kind }))
  }
  const response = await request.response()
  const readability =
    response === null ? undefined : parseDocumentResponse(response)
  if (readability?.status === "failed") return readability
  const errorText = request.failure()?.errorText ?? ""
  const code = NETWORK_ERROR_CODE_PATTERN.exec(errorText)?.[1]
  if (code === undefined) {
    throw new Error(
      `A page navigation failed in an unrecognized way: ${errorText}`
    )
  }
  return buildFailedRendering(Object.freeze({ kind: "transfer-failed", code }))
}

/**
 * Decides why loading the page's document failed.
 *
 * @param error - What the navigation rejected with.
 * @param failedNavigation - Last failed navigation request, or undefined.
 * @param proxy - Proxy of the read.
 * @returns `timed-out`, or what the failed request shows.
 * @throws `error` when it is neither, a crash included.
 */
async function parseDocumentLoadFailure(
  error: unknown,
  failedNavigation: Request | undefined,
  proxy: PageProxy
): Promise<FailedRendering> {
  if (error instanceof playwrightErrors.TimeoutError) {
    return buildFailedRendering(TIMED_OUT_FAILURE)
  }
  if (failedNavigation === undefined) throw error
  return parseFailedNavigation(failedNavigation, proxy)
}

/**
 * Loads the page's document, following its HTTP redirects.
 *
 * @param readPage - Page of the read.
 * @param read - Read in progress.
 * @returns The response that delivered the document once the browser has
 * started showing it, or why it did not arrive.
 * @throws When the navigation failed in an unrecognized way.
 */
async function loadPageDocument(
  readPage: ReadPage,
  read: PageRead
): Promise<DocumentLoadResult> {
  try {
    const response = await readPage.page.goto(read.url, {
      waitUntil: "commit",
      timeout: getRemainingTimeMs(read)
    })
    if (response === null) {
      throw new Error("Loading a page gave no response")
    }
    return Object.freeze({ status: "loaded", response })
  } catch (error) {
    return parseDocumentLoadFailure(
      error,
      readPage.navigationFailures.lastFailedNavigation,
      read.proxy
    )
  }
}

/**
 * Waits for the page to reach one load state before a deadline.
 *
 * @param page - Page of the read.
 * @param state - Load state to wait for.
 * @param deadlineMs - `performance.now()` value by which to stop waiting.
 * @returns True once the state is reached; false when the deadline passes
 * first, which is not a failure.
 * @throws When waiting fails for another reason.
 */
async function waitForLoadStateBefore(
  page: Page,
  state: (typeof SETTLE_LOAD_STATES)[number],
  deadlineMs: number
): Promise<boolean> {
  const timeoutMs = Math.floor(deadlineMs - performance.now())
  if (timeoutMs <= 0) return false
  try {
    await page.waitForLoadState(state, { timeout: timeoutMs })
    return true
  } catch (error) {
    if (!(error instanceof playwrightErrors.TimeoutError)) throw error
    return false
  }
}

/**
 * Waits for the page's DOM to be ready, then for its network to have been
 * quiet for 500 milliseconds.
 *
 * @param page - Page whose document has arrived.
 * @param read - Read in progress.
 * @returns A promise that settles once both are reached, or once the settle
 * limit, or the read's time left minus the document read's reserve, is
 * reached; reaching it is not a failure, and what has rendered is read.
 * @throws When waiting fails for another reason.
 */
async function waitForPageToSettle(page: Page, read: PageRead): Promise<void> {
  const deadlineMs = Math.min(
    performance.now() + read.dependencies.settleTimeoutMs,
    read.deadlineMs - DOCUMENT_READ_RESERVE_MS
  )
  for (const state of SETTLE_LOAD_STATES) {
    const isReached = await waitForLoadStateBefore(page, state, deadlineMs)
    if (!isReached) return
  }
}

/**
 * Decides why the page ended on the browser's error page.
 *
 * @param readPage - Page of the read, which shows that error page.
 * @param proxy - Proxy of the read.
 * @returns What the last failed navigation of the page shows: a later
 * navigation of its own, such as a `<meta>` refresh or a script, failed.
 * @throws When no navigation of the page failed, which the browser does not
 * do before it shows its error page.
 */
async function parseBrowserErrorPage(
  readPage: ReadPage,
  proxy: PageProxy
): Promise<FailedRendering> {
  const failedNavigation = readPage.navigationFailures.lastFailedNavigation
  if (failedNavigation === undefined) {
    throw new Error("A page showed the browser's error page without failing")
  }
  return parseFailedNavigation(failedNavigation, proxy)
}

/**
 * Builds the outcome of reading the document a page ended on.
 *
 * @param readPage - Page of the read.
 * @param document - The document, as Lys read it.
 * @param proxy - Proxy of the read.
 * @returns The page; or why it cannot be read: why the page's last
 * navigation failed when the document is the browser's error page, the
 * rules the document's URL breaks, or the document's status or media type.
 * @throws When the page shows the browser's error page without a failed
 * navigation.
 */
async function buildRenderedResult(
  readPage: ReadPage,
  document: PageDocument,
  proxy: PageProxy
): Promise<PageRenderingResult> {
  if (document.url.startsWith(BROWSER_ERROR_PAGE_SCHEME)) {
    return parseBrowserErrorPage(readPage, proxy)
  }
  const url = parsePageUrl(document.url)
  if (url.status === "invalid") {
    return buildFailedRendering(
      Object.freeze({ kind: "invalid-redirect", problem: url.problem })
    )
  }
  const readability = parseDocumentReadability(
    document.responseStatus,
    document.contentType
  )
  if (readability.status === "failed") return readability
  const page: RenderedPage = Object.freeze({
    url: url.url,
    mediaType: readability.mediaType,
    text: document.text,
    isTruncated: document.isTruncated
  })
  return Object.freeze({ status: "rendered", page })
}

/**
 * Reads the page once its document has arrived.
 *
 * @param readPage - Page of the read.
 * @param response - Response that delivered the first document.
 * @param read - Read in progress.
 * @returns What the page shows once it settled, or why it cannot be read:
 * the first document's status or media type, why a later navigation of the
 * page failed, the rules the URL it ended on breaks, or the status or media
 * type of the document it ended on, however it got there. Each is judged
 * on the document Lys read.
 */
async function readLoadedDocument(
  readPage: ReadPage,
  response: Response,
  read: PageRead
): Promise<PageRenderingResult> {
  const readability = parseDocumentResponse(response)
  if (readability.status === "failed") return readability
  await waitForPageToSettle(readPage.page, read)
  const document = await getPageDocument(readPage.page)
  return buildRenderedResult(readPage, document, read.proxy)
}

/**
 * Loads the page and reads it.
 *
 * @param readPage - Page of the read.
 * @param read - Read in progress.
 * @returns What the page shows, or why it cannot be read.
 * @throws Any failure Lys does not recognize, a crash included.
 */
async function readOpenedPage(
  readPage: ReadPage,
  read: PageRead
): Promise<PageRenderingResult> {
  const load = await loadPageDocument(readPage, read)
  if (load.status === "failed") return load
  return readLoadedDocument(readPage, load.response, read)
}

/**
 * Reads the page in a started browser.
 *
 * @param read - Read in progress.
 * @param browser - Browser of the read, borrowed; the caller closes it.
 * @returns What the page shows, or why it cannot be read; `crashed` when the
 * page crashes the browser at any step, before or after its document
 * arrived, a step still waiting on the crashed page included.
 * @throws Any failure Lys does not recognize.
 * @remarks Playwright reports a page's crash before it rejects the calls
 * that waited on the page, so the crash ends the wait first, and the calls'
 * later failures are left behind with the step.
 */
async function readInBrowser(
  read: PageRead,
  browser: Browser
): Promise<PageRenderingResult> {
  const readPage = await openReadPage(browser)
  try {
    return await waitForReadStep(
      readOpenedPage(readPage, read),
      readPage.crashSignal
    )
  } catch (error) {
    if (error !== readPage.crashSignal.reason) throw error
    return buildFailedRendering(Object.freeze({ kind: "crashed" }))
  }
}

/**
 * Reads the page in a browser whose traffic goes through the read's proxy.
 *
 * @param read - Read in progress.
 * @returns What the page shows, or why it cannot be read; `timed-out` only
 * when the read's time limit ended the wait.
 * @throws The stop reason once the read is stopped; any failure Lys does not
 * recognize, closing the browser included, and when both the read and
 * closing fail, an `AggregateError` holding both.
 * @remarks Stop or the read's time limit ends the wait at once; the browser
 * is then closed, which ends every step still running. The time limit's
 * timer and the link to the reply's Stop are released when the read ends.
 */
async function readThroughProxy(read: PageRead): Promise<PageRenderingResult> {
  const start = await startPageBrowser(read)
  if (start.status === "failed") return start
  const deadlineReason = new Error("The page read reached its time limit")
  const readStop = new AbortController()
  const deadlineTimer = setTimeout(
    () => readStop.abort(deadlineReason),
    getRemainingTimeMs(read)
  )
  const forwardStop = () => readStop.abort(read.abortSignal.reason)
  read.abortSignal.addEventListener("abort", forwardStop, { once: true })
  if (read.abortSignal.aborted) forwardStop()
  try {
    return await closeAfterUse(
      waitForReadStep(readInBrowser(read, start.browser), readStop.signal),
      () => start.browser.close()
    )
  } catch (error) {
    if (error !== deadlineReason) throw error
    return buildFailedRendering(TIMED_OUT_FAILURE)
  } finally {
    clearTimeout(deadlineTimer)
    read.abortSignal.removeEventListener("abort", forwardStop)
  }
}

/**
 * Reads one page in a fresh headless browser.
 *
 * @param url - Page to read, checked by the page URL rules.
 * @param abortSignal - Stops the read.
 * @param dependencies - Browser, address rule, failure reporters, and time
 * limits.
 * @returns What the browser showed: the HTML of the page, or a plain-text
 * page's text, and the URL it ended on; or why the page could not be read.
 * @throws The stop reason once `abortSignal` aborts; nothing is started when
 * it already has. Any failure Lys does not recognize, which is a defect.
 * @remarks Starts a proxy that applies the address rule to every connection,
 * then Chromium with that proxy, Chromium's sandbox, and a context that keeps
 * nothing between reads. The page's scripts run and its redirects are
 * followed. Once its document has arrived, the read waits, up to the settle
 * limit, for its DOM to be ready and its network to go quiet, then reads
 * the document the page ended on, hidden text included, and checks that
 * document's status and media type, however the page reached it. The
 * browser and the proxy are closed whatever the outcome, Stop included, so
 * nothing keeps running after the read.
 */
export async function getRenderedPage(
  url: PageUrl,
  abortSignal: AbortSignal,
  dependencies: PageRenderingDependencies
): Promise<PageRenderingResult> {
  abortSignal.throwIfAborted()
  const deadlineMs = performance.now() + dependencies.readTimeoutMs
  const executableProblem = await findBrowserExecutableProblem(
    dependencies.browserExecutablePath
  )
  if (executableProblem !== undefined) {
    dependencies.reportBrowserFailure(executableProblem.cause)
    return buildFailedRendering(executableProblem.failure)
  }
  abortSignal.throwIfAborted()
  const proxy = await PageProxy.open({
    lookupHostAddresses: dependencies.lookupHostAddresses,
    isBlockedAddress: dependencies.isBlockedAddress,
    limits: PAGE_PROXY_LIMITS
  })
  const read: PageRead = Object.freeze({
    url,
    abortSignal,
    dependencies,
    proxy,
    deadlineMs
  })
  return closeAfterUse(readThroughProxy(read), () =>
    proxy[Symbol.asyncDispose]()
  )
}
