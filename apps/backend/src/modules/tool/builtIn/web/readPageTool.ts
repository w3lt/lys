import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
import type {
  AddWebSources,
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  BuiltInToolRunContext,
  ParsedBuiltInToolCall
} from "../builtInTool"
import { buildPageSourceCandidate, formatPageEvidence } from "./pageEvidence"
import {
  extractPageArticle,
  type PageArticle,
  type PageExtractionResult
} from "./pageExtraction"
import {
  getRenderedPage,
  type PageRenderingDependencies,
  type PageRenderingFailure,
  type RenderedPage
} from "./pageRendering"
import {
  formatPageUrlProblem,
  MAXIMUM_PAGE_URL_LENGTH,
  parsePageUrl,
  type PageUrl
} from "./pageUrl"
import {
  calculatePagePassages,
  MAXIMUM_SELECTED_PASSAGE_LENGTH,
  selectPagePassages
} from "./passageDistillation"

/** Name the model calls the tool by. */
export const READ_PAGE_TOOL_NAME = "read_page"

/** Most UTF-16 code units of a trimmed focus, inclusive. */
export const MAXIMUM_PAGE_FOCUS_LENGTH = 200

/**
 * Milliseconds one read may take in production, from the start of the read,
 * before the browser is checked and started, to reading the page's
 * document.
 */
export const PAGE_READ_TIMEOUT_MS = 30_000

/**
 * Most milliseconds a read waits in production, once the page's document
 * has arrived, for its DOM to be ready and its network to go quiet before
 * reading what has rendered.
 */
export const PAGE_SETTLE_TIMEOUT_MS = 10_000

/**
 * Sentences that follow a browser that is missing or cannot start, telling
 * the person what to do.
 */
const BROWSER_HELP_SENTENCES =
  "Please contact w3lt@negentropy.studio to report problem and require help. Only repair it yourself if you know exactly what you are doing."

/** Milliseconds in one second. */
const MILLISECONDS_PER_SECOND = 1_000

/** Why a page too large or too deep for Lys cannot be read. */
const TOO_COMPLEX_PAGE_REASON =
  "the page is too large or too deeply nested for Lys to read."

/** Read failures whose explanation depends on nothing but their kind. */
type FixedReasonFailureKind = Exclude<
  PageRenderingFailure["kind"],
  | "timed-out"
  | "transfer-failed"
  | "http-status"
  | "unsupported-content-type"
  | "invalid-redirect"
>

/** Why a page could not be read, for each failure that carries no detail. */
const FIXED_FAILURE_REASONS = Object.freeze({
  "browser-missing": `Lys's browser is missing. ${BROWSER_HELP_SENTENCES}`,
  "browser-failed": `Lys's browser could not start. ${BROWSER_HELP_SENTENCES}`,
  "blocked-address":
    "its address, or the address of a page it redirects to, belongs to this machine or a private network, which Lys never reads.",
  "unresolvable-host":
    "its host name, or the host name of a page it redirects to, could not be found.",
  crashed: "the page crashed Lys's browser while loading."
} satisfies Readonly<Record<FixedReasonFailureKind, string>>)

/** Input of one parsed read. */
type PageReadInput = Readonly<{
  /** Page to read. */
  url: PageUrl
  /** What the model wants to learn, trimmed; undefined to read from the start. */
  focus: string | undefined
}>

/** Outcome of parsing a read's arguments. */
type PageReadInputResult =
  | Readonly<{
      /** The arguments describe a read. */
      status: "parsed"
      /** The read. */
      input: PageReadInput
    }>
  | Readonly<{
      /** The arguments cannot describe a read. */
      status: "invalid"
      /** Explanation the model reads. */
      message: string
    }>

/**
 * Builds the definition of the read-page tool.
 *
 * @returns The validated, frozen definition: it reaches past this machine,
 * runs in the backend, and states its limits to the model.
 */
export function buildReadPageDefinition(): ToolDefinition {
  const timeoutSeconds = PAGE_READ_TIMEOUT_MS / MILLISECONDS_PER_SECOND
  return toolDefinitionSchema.parse({
    name: READ_PAGE_TOOL_NAME,
    description: `Read one public web page in a browser and return its title, URL, and main text, to answer from and cite. The page's scripts run and its redirects are followed. Reads http and https pages that serve HTML or plain text, within ${timeoutSeconds} seconds. Pages that need signing in, PDFs, and addresses on this machine or a private network cannot be read. A page longer than ${MAXIMUM_SELECTED_PASSAGE_LENGTH} characters is cut to the passages that best match focus, or to its beginning.`,
    group: "network",
    access: "network",
    runner: "backend",
    arguments: [
      {
        type: "string",
        name: "url",
        description: `Absolute http or https URL of the page, at most ${MAXIMUM_PAGE_URL_LENGTH} characters.`
      },
      {
        type: "string",
        name: "focus",
        description: `What you want to learn from the page, in a few words, at most ${MAXIMUM_PAGE_FOCUS_LENGTH} characters. Omit it to read the page from its start.`,
        required: false
      }
    ]
  })
}

/**
 * Builds the result of a read that could not happen.
 *
 * @param url - Page the read was for.
 * @param reason - Why, as a clause after "Lys could not read the page".
 * @returns A frozen failed result.
 */
function buildFailedReadResult(url: string, reason: string): BuiltInToolResult {
  return Object.freeze({
    status: "failed",
    content: `Lys could not read ${url}: ${reason}`
  })
}

/**
 * Formats why a browser read failed.
 *
 * @param failure - Recognized read failure.
 * @param readTimeoutMs - Time limit of the read.
 * @returns A clause for {@link buildFailedReadResult}: the read's time
 * limit, or the failure's detail, for a failure that carries one; otherwise
 * the fixed reason of its kind, which for a browser that is missing or
 * cannot start says what the person should do.
 */
function formatPageRenderingFailure(
  failure: PageRenderingFailure,
  readTimeoutMs: number
): string {
  switch (failure.kind) {
    case "timed-out":
      return `it did not load within ${readTimeoutMs / MILLISECONDS_PER_SECOND} seconds.`
    case "transfer-failed":
      return `the browser could not load it (${failure.code}).`
    case "http-status":
      return `the server answered with HTTP status ${failure.status}.`
    case "unsupported-content-type":
      return `it is not a web page (${failure.mediaType ?? "no content type"}). Lys reads HTML and plain-text pages only.`
    case "invalid-redirect":
      return `it redirects to an address Lys may not read. ${formatPageUrlProblem(failure.problem)}`
    default:
      return FIXED_FAILURE_REASONS[failure.kind]
  }
}

/** A page read's main text and what to number it with. */
type PageEvidenceSource = Readonly<{
  /** Article extracted from the page. */
  article: PageArticle
  /** Numbers the page as a source of the conversation. */
  addWebSources: AddWebSources
}>

/**
 * Builds the evidence of a page with main text: numbers the page as a source
 * and shows the passages that matter.
 *
 * @param page - Page Lys read.
 * @param evidenceSource - Its article and the source numbering.
 * @param focus - What the model wants to learn, or undefined.
 * @returns The page evidence, which shows the page's source number, and the
 * numbered page.
 * @throws If the numbering returns no source for the page, which breaks its
 * contract.
 */
function buildPageEvidenceResult(
  page: RenderedPage,
  { article, addWebSources }: PageEvidenceSource,
  focus: string | undefined
): BuiltInToolResult {
  const sources = addWebSources([buildPageSourceCandidate(page.url, article)])
  const source = sources[0]
  if (source === undefined) throw new Error("The page was not numbered")
  const selection = selectPagePassages(
    calculatePagePassages(article.blocks),
    focus
  )
  const content = formatPageEvidence({
    url: page.url,
    sourceNumber: source.number,
    article,
    selection,
    isTruncated: page.isTruncated
  })
  return Object.freeze({ status: "succeeded", content, sources })
}

/**
 * Builds what the model reads about a page Lys read.
 *
 * @param page - Page Lys read.
 * @param extraction - Main text extracted from it.
 * @param input - What the model wants to learn, or undefined, and the
 * source numbering.
 * @returns The page evidence, or why the page has nothing to read; only a
 * page with main text is numbered as a source.
 */
function buildPageReadResult(
  page: RenderedPage,
  extraction: PageExtractionResult,
  input: Readonly<{ focus: string | undefined; addWebSources: AddWebSources }>
): BuiltInToolResult {
  switch (extraction.status) {
    case "no-readable-text":
      return buildFailedReadResult(page.url, "the page has no readable text.")
    case "too-complex":
      return buildFailedReadResult(page.url, TOO_COMPLEX_PAGE_REASON)
    case "extracted":
      return buildPageEvidenceResult(
        page,
        { article: extraction.article, addWebSources: input.addWebSources },
        input.focus
      )
  }
}

/**
 * Reads one page and builds what the model reads about it.
 *
 * @param input - Page and focus.
 * @param context - Stops the read and numbers the page as a source.
 * @param dependencies - Browser, address rule, and time limits.
 * @returns The page evidence, or why the page could not be read.
 * @throws The abort reason once the context's signal aborts, and any
 * failure Lys does not recognize.
 */
async function runPageRead(
  input: PageReadInput,
  { abortSignal, addWebSources }: BuiltInToolRunContext,
  dependencies: PageRenderingDependencies
): Promise<BuiltInToolResult> {
  const rendering = await getRenderedPage(input.url, abortSignal, dependencies)
  if (rendering.status === "failed") {
    return buildFailedReadResult(
      input.url,
      formatPageRenderingFailure(rendering.failure, dependencies.readTimeoutMs)
    )
  }
  abortSignal.throwIfAborted()
  const extraction = extractPageArticle(rendering.page)
  return buildPageReadResult(rendering.page, extraction, {
    focus: input.focus,
    addWebSources
  })
}

/** Outcome of parsing a read's focus. */
type PageFocusResult =
  | Readonly<{
      /** The focus can be used. */
      status: "parsed"
      /** Trimmed focus, or undefined when it was omitted or blank. */
      focus: string | undefined
    }>
  | Readonly<{
      /** The focus cannot be used. */
      status: "invalid"
      /** Explanation the model reads. */
      message: string
    }>

/**
 * Parses the focus argument of a read.
 *
 * @param focus - Untrusted focus value; absent when the model omitted it.
 * @returns The trimmed focus, undefined when it is absent or blank, or an
 * explanation when it is not text or is too long.
 */
function parsePageFocus(
  focus: BuiltInToolCallArguments[string] | undefined
): PageFocusResult {
  if (focus === undefined) {
    return Object.freeze({ status: "parsed", focus: undefined })
  }
  if (typeof focus !== "string") {
    return Object.freeze({
      status: "invalid",
      message: "The focus argument must be text."
    })
  }
  const trimmed = focus.trim()
  if (trimmed.length > MAXIMUM_PAGE_FOCUS_LENGTH) {
    return Object.freeze({
      status: "invalid",
      message: `The focus is longer than ${MAXIMUM_PAGE_FOCUS_LENGTH} characters.`
    })
  }
  return Object.freeze({
    status: "parsed",
    focus: trimmed === "" ? undefined : trimmed
  })
}

/**
 * Parses the arguments of one read.
 *
 * @param callArguments - Argument values that matched the definition in
 * type.
 * @returns The read, or an explanation naming the first problem.
 */
function parsePageReadInput(
  callArguments: BuiltInToolCallArguments
): PageReadInputResult {
  const { url } = callArguments
  if (typeof url !== "string") {
    return Object.freeze({
      status: "invalid",
      message: "The url argument must be text."
    })
  }
  const parsedUrl = parsePageUrl(url)
  if (parsedUrl.status === "invalid") {
    return Object.freeze({
      status: "invalid",
      message: `Lys cannot read ${url}: ${formatPageUrlProblem(parsedUrl.problem)}`
    })
  }
  const parsedFocus = parsePageFocus(callArguments.focus)
  if (parsedFocus.status === "invalid") return parsedFocus
  const input: PageReadInput = Object.freeze({
    url: parsedUrl.url,
    focus: parsedFocus.focus
  })
  return Object.freeze({ status: "parsed", input })
}

/**
 * Owns the read settings to read one public web page per call in a fresh
 * browser and give the model its main text to cite, never reaching this
 * machine or a private network.
 *
 * @remarks Implements {@link BuiltInTool}. Parsing checks the URL by the
 * page URL rules before the person is asked; a run reads the page in a
 * fresh headless browser whose every connection passes the address rule,
 * with the page's scripts running and its redirects followed, reads all of
 * its text, hidden text included, extracts its main text, keeps the
 * passages that fit, and frames them as untrusted page content. Every failure the model can act on becomes its result; only a
 * defect rejects. Owns no resource; each run starts and closes its own
 * browser and proxy. Concurrency model: reentrant.
 */
export default class ReadPageTool implements BuiltInTool {
  /** Browser, address rule, and time limits of every read. */
  readonly #pageRenderingDependencies: PageRenderingDependencies

  /**
   * Creates the tool without starting or contacting anything.
   *
   * @param pageRenderingDependencies - Browser, address rule, and time
   * limits, lent for the tool's lifetime.
   */
  public constructor(pageRenderingDependencies: PageRenderingDependencies) {
    this.#pageRenderingDependencies = pageRenderingDependencies
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for page reads.
   *
   * @param callArguments - The interface-defined argument values: `url` and
   * an optional `focus`.
   * @returns The interface-defined outcome; `invalid` for a URL that is not
   * an absolute http or https URL, is too long, carries credentials, or
   * names this machine or a blocked IP address, and for a focus that is too
   * long.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    const parsed = parsePageReadInput(callArguments)
    if (parsed.status === "invalid") return parsed
    const dependencies = this.#pageRenderingDependencies
    return Object.freeze({
      status: "parsed",
      runToolCall: (context: BuiltInToolRunContext) =>
        runPageRead(parsed.input, context, dependencies)
    })
  }
}
