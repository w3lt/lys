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
import PageProxy, { type PageProxyLimits } from "./pageProxy"
import {
  buildVisibleHtml,
  formatCutPageText,
  getPageSnapshot,
  MAXIMUM_PAGE_TEXT_LENGTH
} from "./pageSnapshot"
import { parsePageUrl, type PageUrl, type PageUrlProblem } from "./pageUrl"
import { formatSingleLineText } from "./untrustedText"
import { hasErrorCode, type ConnectionAddressRule } from "./webConnection"

/** How Lys reads a page: as HTML, or as plain text. */
export type PageMediaType = "text/html" | "text/plain"

/** A page Lys read in the browser. */
export type RenderedPage = Readonly<{
  /** URL of the page as the browser showed it, after every redirect. */
  url: PageUrl
  /** Whether `text` is HTML or plain text. */
  mediaType: PageMediaType
  /**
   * For HTML, the rendered page's HTML, built from its snapshot; for plain
   * text, the page's text.
   */
  text: string
  /**
   * Whether the page was longer than {@link MAXIMUM_PAGE_TEXT_LENGTH} and
   * only its beginning was read.
   */
  isTruncated: boolean
}>

/** What one browser read needs from its environment. */
export type PageRenderingDependencies = ConnectionAddressRule &
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
      /** The page's document did not arrive within the read's time limit. */
      kind: "timed-out"
    }>
  | Readonly<{
      /** The browser could not load the page's document. */
      kind: "transfer-failed"
      /** Chromium network error, such as `ERR_CONNECTION_REFUSED`. */
      code: string
    }>
  | Readonly<{
      /** The page's document came with a status other than 2xx. */
      kind: "http-status"
      /** HTTP status code of the document. */
      status: number
    }>
  | Readonly<{
      /** The document is not HTML or plain text. */
      kind: "unsupported-content-type"
      /**
       * Media type the server named, cleaned and cut to 100 characters;
       * undefined when it named none.
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
  | Readonly<{
      /** The rendered page has too many nodes to read. */
      kind: "too-complex"
    }>

/** Outcome of one browser read. */
export type PageRenderingResult =
  | Readonly<{
      /** The page was read. */
      status: "rendered"
      /** What the browser showed. */
      page: RenderedPage
    }>
  | Readonly<{
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
  /** Browser, address rule, and time limits. */
  dependencies: PageRenderingDependencies
  /** Proxy the browser's traffic goes through; borrowed from the read. */
  proxy: PageProxy
  /** `performance.now()` value by which the read must end, in milliseconds. */
  deadlineMs: number
}>

/** The one page of a read and the navigations of its own frame that failed. */
type ReadPage = Readonly<{
  /** Page of the read, in the read's browser. */
  page: Page
  /**
   * Failed navigations of the page's own frame, in order, for the whole
   * read: its first document's and every later one's.
   */
  failedNavigations: readonly Request[]
  /**
   * Aborts once the page crashes the browser, which a call waiting on the
   * page's renderer would otherwise never learn.
   */
  crashSignal: AbortSignal
}>

/** A failed outcome, which every step's result type includes. */
type FailedRendering = Readonly<{
  status: "failed"
  failure: PageRenderingFailure
}>

/** Outcome of starting the browser. */
type BrowserLaunchResult =
  | Readonly<{
      /** The browser started; the read owns it. */
      status: "launched"
      /** The started browser. */
      browser: Browser
    }>
  | Readonly<{ status: "failed"; failure: PageRenderingFailure }>

/** Outcome of loading the page's document. */
type DocumentNavigationResult =
  | Readonly<{
      /** The document loaded. */
      status: "loaded"
      /** Response that delivered it, after every HTTP redirect. */
      response: Response
    }>
  | Readonly<{ status: "failed"; failure: PageRenderingFailure }>

/** Whether a loaded document can be read, and how. */
type DocumentReadability =
  | Readonly<{
      /** The document is HTML or plain text with a 2xx status. */
      status: "readable"
      /** How it is read. */
      mediaType: PageMediaType
    }>
  | Readonly<{ status: "failed"; failure: PageRenderingFailure }>

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

/** Milliseconds kept at the end of a read for taking the page's snapshot. */
const SNAPSHOT_RESERVE_MS = 2_000

/** Most characters of a media type a failure reports. */
const MAXIMUM_REPORTED_MEDIA_TYPE_LENGTH = 100

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

/** Media types Lys reads, mapped to how it reads them. */
const PAGE_MEDIA_TYPES: ReadonlyMap<string, PageMediaType> = new Map([
  ["text/html", "text/html"],
  ["application/xhtml+xml", "text/html"],
  ["text/plain", "text/plain"]
])

/** File error codes that mean the browser's executable does not exist. */
const MISSING_FILE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"])

/** Finds the error code in a Chromium network failure, such as `net::ERR_ABORTED`. */
const NETWORK_ERROR_CODE_PATTERN = /^net::(ERR_[A-Z0-9_]+)$/

/**
 * Word in every error Playwright raises because the page crashed, such as
 * "Page crashed" from a navigation and "Navigation failed because page
 * crashed!" from a wait; Playwright gives no other way to tell a crash from
 * other failures of a pending call.
 */
const PAGE_CRASH_MESSAGE_WORD = "crashed"

/** Port of an https URL that names none. */
const DEFAULT_HTTPS_PORT = 443

/** Port of an http URL that names none. */
const DEFAULT_HTTP_PORT = 80

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
 * it exists but is not executable, or undefined when it can run.
 * @throws A failure of the check that carries no system error code.
 */
async function findBrowserExecutableFailure(
  executablePath: string
): Promise<PageRenderingFailure | undefined> {
  try {
    await access(executablePath, fileConstants.X_OK)
    return undefined
  } catch (error) {
    if (!hasErrorCode(error)) throw error
    return Object.freeze({
      kind: MISSING_FILE_CODES.has(error.code)
        ? "browser-missing"
        : "browser-failed"
    })
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
 * Waits for a step of a read unless the read is stopped first.
 *
 * @param step - Step in progress.
 * @param signal - Ends the wait.
 * @returns What the step resolved with.
 * @throws The signal's reason once it aborts, or the step's failure. A step
 * left behind keeps running until its browser is closed; its later failure
 * is ignored.
 */
async function waitForReadStep<TResult>(
  step: Promise<TResult>,
  signal: AbortSignal
): Promise<TResult> {
  signal.throwIfAborted()
  const { promise: stopped, reject } = Promise.withResolvers<never>()
  const rejectStopped = () => reject(signal.reason)
  signal.addEventListener("abort", rejectStopped, { once: true })
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
 * @returns Launch options: the executable, headless, Chromium's sandbox on,
 * every request through the read's proxy with its credentials, this
 * machine's own addresses included, and a start timeout of the time left.
 */
function buildLaunchOptions(read: PageRead): LaunchOptions {
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
    timeout: getRemainingTimeMs(read),
    proxy,
    args: [...BROWSER_LAUNCH_ARGUMENTS]
  }
}

/**
 * Starts the browser of one read.
 *
 * @param read - Read in progress.
 * @returns The started browser, owned by the caller, or `browser-failed`.
 * @throws The stop reason when the read was stopped while the browser
 * started; a browser that started anyway is closed first. Starting cannot be
 * interrupted, so a stop waits for it, at most the read's time limit.
 */
async function launchPageBrowser(read: PageRead): Promise<BrowserLaunchResult> {
  const [launch] = await Promise.allSettled([
    chromium.launch(buildLaunchOptions(read))
  ])
  if (launch?.status === "fulfilled" && read.abortSignal.aborted) {
    await launch.value.close()
  }
  read.abortSignal.throwIfAborted()
  if (launch?.status !== "fulfilled") {
    return buildFailedRendering(Object.freeze({ kind: "browser-failed" }))
  }
  return Object.freeze({ status: "launched", browser: launch.value })
}

/**
 * Stops the browser from fetching a resource that carries no text.
 *
 * @param route - Request the page is about to send.
 * @returns A promise that settles once the request is let through or
 * aborted.
 */
function routeTextlessResource(route: Route): Promise<void> {
  return TEXTLESS_RESOURCE_TYPES.has(route.request().resourceType())
    ? route.abort()
    : route.continue()
}

/**
 * Keeps a request when it is a failed navigation of the page itself.
 *
 * @param failedNavigations - Failed navigations so far, in order.
 * @param page - Page of the read.
 * @param request - Request that failed.
 */
function addFailedNavigation(
  failedNavigations: Request[],
  page: Page,
  request: Request
): void {
  if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
    failedNavigations.push(request)
  }
}

/**
 * Opens the one page of a read in a fresh browser context.
 *
 * @param browser - Browser of the read.
 * @returns A page whose context keeps no service worker and accepts no
 * download, and that never fetches images, fonts, or media, with the
 * failed navigations of its own frame kept, and its crash watched, from now
 * on.
 */
async function openReadPage(browser: Browser): Promise<ReadPage> {
  const context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: false
  })
  const page = await context.newPage()
  await page.route("**/*", routeTextlessResource)
  const failedNavigations: Request[] = []
  page.on("requestfailed", (request) =>
    addFailedNavigation(failedNavigations, page, request)
  )
  const crash = new AbortController()
  page.once("crash", () =>
    crash.abort(new Error("The page crashed Lys's browser"))
  )
  return Object.freeze({ page, failedNavigations, crashSignal: crash.signal })
}

/**
 * Finds the port a URL connects to.
 *
 * @param url - http or https URL.
 * @returns Its port, or the scheme's default port.
 */
function findUrlPort(url: URL): number {
  if (url.port !== "") return Number(url.port)
  return url.protocol === "https:" ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT
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
 * Decides whether a loaded document can be read.
 *
 * @param response - Response that delivered the document.
 * @returns How to read it, or why it cannot be read: its status or its
 * media type.
 */
function classifyDocumentResponse(response: Response): DocumentReadability {
  if (!response.ok()) {
    return buildFailedRendering(
      Object.freeze({ kind: "http-status", status: response.status() })
    )
  }
  const mediaType = parseMediaType(response.headers()["content-type"])
  const pageMediaType =
    mediaType === undefined ? undefined : PAGE_MEDIA_TYPES.get(mediaType)
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
 * Decides why a navigation request of the page failed.
 *
 * @param request - The failed navigation, possibly a redirect's target.
 * @param proxy - Proxy of the read, which knows what it refused.
 * @returns The proxy's refusal of the request's host; else the document's
 * status or media type when its response arrived, as for a download; else
 * the network error.
 * @throws When the failure is not a Chromium network error.
 */
async function classifyFailedNavigation(
  request: Request,
  proxy: PageProxy
): Promise<FailedRendering> {
  const target = new URL(request.url())
  const refusal = proxy.findRefusal(target.hostname, findUrlPort(target))
  if (refusal !== undefined) {
    return buildFailedRendering(Object.freeze({ kind: refusal.kind }))
  }
  const response = await request.response()
  const readability =
    response === null ? undefined : classifyDocumentResponse(response)
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
async function classifyNavigationFailure(
  error: unknown,
  failedNavigation: Request | undefined,
  proxy: PageProxy
): Promise<DocumentNavigationResult> {
  if (error instanceof playwrightErrors.TimeoutError) {
    return buildFailedRendering(Object.freeze({ kind: "timed-out" }))
  }
  if (failedNavigation === undefined) throw error
  return classifyFailedNavigation(failedNavigation, proxy)
}

/**
 * Starts loading the page's document, following its HTTP redirects.
 *
 * @param readPage - Page of the read.
 * @param read - Read in progress.
 * @returns The response that delivered the document once the browser has
 * started showing it, or why it did not arrive.
 * @throws When the navigation failed in an unrecognized way.
 */
async function navigateToDocument(
  readPage: ReadPage,
  read: PageRead
): Promise<DocumentNavigationResult> {
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
    return classifyNavigationFailure(
      error,
      readPage.failedNavigations.at(-1),
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
 * limit, or the read's time left minus the snapshot's reserve, is reached;
 * reaching it is not a failure, and what has rendered is read.
 * @throws When waiting fails for another reason.
 */
async function waitForPageToSettle(page: Page, read: PageRead): Promise<void> {
  const deadlineMs = Math.min(
    performance.now() + read.dependencies.settleTimeoutMs,
    read.deadlineMs - SNAPSHOT_RESERVE_MS
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
async function classifyBrowserErrorPage(
  readPage: ReadPage,
  proxy: PageProxy
): Promise<FailedRendering> {
  const failedNavigation = readPage.failedNavigations.at(-1)
  if (failedNavigation === undefined) {
    throw new Error("A page showed the browser's error page without failing")
  }
  return classifyFailedNavigation(failedNavigation, proxy)
}

/**
 * Removes the fragment of a URL.
 *
 * @param url - Absolute URL.
 * @returns The URL without its `#` part.
 */
function removeUrlFragment(url: string): string {
  const parsedUrl = new URL(url)
  parsedUrl.hash = ""
  return parsedUrl.href
}

/**
 * Reads a rendered HTML page.
 *
 * @param page - Page that finished rendering.
 * @param url - URL the browser shows, checked.
 * @returns The HTML of what the page shows, or `too-complex`.
 */
async function readHtmlPage(
  page: Page,
  url: PageUrl
): Promise<PageRenderingResult> {
  const snapshot = await getPageSnapshot(page)
  const visibleHtml =
    snapshot.status === "taken" ? buildVisibleHtml(snapshot.snapshot) : snapshot
  if (visibleHtml.status === "too-complex") {
    return buildFailedRendering(Object.freeze({ kind: "too-complex" }))
  }
  const renderedPage: RenderedPage = Object.freeze({
    url,
    mediaType: "text/html",
    text: visibleHtml.html,
    isTruncated: visibleHtml.isTruncated
  })
  return Object.freeze({ status: "rendered", page: renderedPage })
}

/**
 * Reads a plain-text page.
 *
 * @param page - Page that shows the text.
 * @param url - URL the browser shows, checked.
 * @param read - Read in progress.
 * @returns The page's text, cut at {@link MAXIMUM_PAGE_TEXT_LENGTH}.
 * @remarks Reads the text the browser shows, in Playwright's own script
 * world, which a page's scripts cannot reach; a plain-text page has none.
 */
async function readPlainTextPage(
  page: Page,
  url: PageUrl,
  read: PageRead
): Promise<PageRenderingResult> {
  const text =
    (await page
      .locator("body")
      .textContent({ timeout: Math.max(1, getRemainingTimeMs(read)) })) ?? ""
  const isTruncated = text.length > MAXIMUM_PAGE_TEXT_LENGTH
  const renderedPage: RenderedPage = Object.freeze({
    url,
    mediaType: "text/plain",
    text: isTruncated ? formatCutPageText(text) : text,
    isTruncated
  })
  return Object.freeze({ status: "rendered", page: renderedPage })
}

/**
 * Reads the page once its document has arrived.
 *
 * @param readPage - Page of the read.
 * @param response - Response that delivered the document.
 * @param read - Read in progress.
 * @returns What the page shows once it settled, or why it cannot be read:
 * the document's status or media type, why a later navigation of the page
 * failed, or the rules the URL it ended on breaks. A plain-text document is
 * read as text while the page still shows it, and as HTML once the page
 * went on to another document.
 */
async function readLoadedDocument(
  readPage: ReadPage,
  response: Response,
  read: PageRead
): Promise<PageRenderingResult> {
  const readability = classifyDocumentResponse(response)
  if (readability.status === "failed") return readability
  const { page } = readPage
  await waitForPageToSettle(page, read)
  const shownUrl = page.url()
  if (shownUrl.startsWith(BROWSER_ERROR_PAGE_SCHEME)) {
    return classifyBrowserErrorPage(readPage, read.proxy)
  }
  const finalUrl = parsePageUrl(shownUrl)
  if (finalUrl.status === "invalid") {
    return buildFailedRendering(
      Object.freeze({ kind: "invalid-redirect", problem: finalUrl.problem })
    )
  }
  const isShowingDocument =
    removeUrlFragment(shownUrl) === removeUrlFragment(response.url())
  return readability.mediaType === "text/plain" && isShowingDocument
    ? readPlainTextPage(page, finalUrl.url, read)
    : readHtmlPage(page, finalUrl.url)
}

/**
 * Answers whether a Playwright call failed because the page crashed.
 *
 * @param error - What the call rejected with.
 * @returns True for an error whose message says the page crashed.
 */
function isPageCrash(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes(PAGE_CRASH_MESSAGE_WORD)
  )
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
  const navigation = await navigateToDocument(readPage, read)
  if (navigation.status === "failed") return navigation
  return readLoadedDocument(readPage, navigation.response, read)
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
    if (!readPage.crashSignal.aborted && !isPageCrash(error)) throw error
    return buildFailedRendering(Object.freeze({ kind: "crashed" }))
  }
}

/**
 * Reads the page in a browser whose traffic goes through the read's proxy.
 *
 * @param read - Read in progress.
 * @returns What the page shows, or why it cannot be read.
 * @throws The stop reason once the read is stopped.
 * @remarks Stop or the read's time limit ends the wait at once; the browser
 * is then closed, which ends every step still running.
 */
async function readThroughProxy(read: PageRead): Promise<PageRenderingResult> {
  const launch = await launchPageBrowser(read)
  if (launch.status === "failed") return launch
  const deadline = AbortSignal.timeout(getRemainingTimeMs(read))
  const readSignal = AbortSignal.any([read.abortSignal, deadline])
  try {
    return await closeAfterUse(
      waitForReadStep(readInBrowser(read, launch.browser), readSignal),
      () => launch.browser.close()
    )
  } catch (error) {
    read.abortSignal.throwIfAborted()
    if (!deadline.aborted) throw error
    return buildFailedRendering(Object.freeze({ kind: "timed-out" }))
  }
}

/**
 * Reads one page in a fresh headless browser.
 *
 * @param url - Page to read, checked by the page URL rules.
 * @param abortSignal - Stops the read.
 * @param dependencies - Browser, address rule, and time limits.
 * @returns What the browser showed: the HTML of the visible page, or a
 * plain-text page's text, and the URL it ended on; or why the page could not
 * be read.
 * @throws The stop reason once `abortSignal` aborts; nothing is started when
 * it already has. Any failure Lys does not recognize, which is a defect.
 * @remarks Starts a proxy that applies the address rule to every connection,
 * then Chromium with that proxy, Chromium's sandbox, and a context that keeps
 * nothing between reads. The page's scripts run and its redirects are
 * followed. Once its document has arrived, the read waits, up to the settle
 * limit, for its DOM to be ready and its network to go quiet, then stops the
 * page's scripts and takes a snapshot of what has rendered. The browser
 * and the proxy are closed whatever the outcome, Stop included, so nothing
 * keeps running after the read.
 */
export async function getRenderedPage(
  url: PageUrl,
  abortSignal: AbortSignal,
  dependencies: PageRenderingDependencies
): Promise<PageRenderingResult> {
  abortSignal.throwIfAborted()
  const deadlineMs = performance.now() + dependencies.readTimeoutMs
  const executableFailure = await findBrowserExecutableFailure(
    dependencies.browserExecutablePath
  )
  if (executableFailure !== undefined) {
    return buildFailedRendering(executableFailure)
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
  return closeAfterUse(readThroughProxy(read), () => proxy.close())
}
