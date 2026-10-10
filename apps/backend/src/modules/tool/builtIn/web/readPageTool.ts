import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  ParsedBuiltInToolCall
} from "../builtInTool"
import { formatPageEvidence } from "./pageEvidence"
import { extractPageArticle, type PageExtractionResult } from "./pageExtraction"
import {
  getWebPage,
  MAXIMUM_PAGE_REDIRECTS,
  type PageRequestDependencies,
  type PageRequestFailure,
  type PageResponse
} from "./pageRequest"
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
 * Milliseconds one read may take in production, redirects and body
 * included.
 */
export const PAGE_READ_TIMEOUT_MS = 15_000

/** Milliseconds in one second. */
const MILLISECONDS_PER_SECOND = 1_000

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
    description: `Read one public web page and return its title, URL, and main text, to answer from and cite. Reads http and https pages that serve HTML or plain text, within ${timeoutSeconds} seconds and ${MAXIMUM_PAGE_REDIRECTS} redirects. Pages that need JavaScript, PDFs, and addresses on this machine or a private network cannot be read. A page longer than ${MAXIMUM_SELECTED_PASSAGE_LENGTH} characters is cut to the passages that best match focus, or to its beginning.`,
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
 * Formats why a page request failed.
 *
 * @param failure - Recognized request failure.
 * @param requestTimeoutMs - Time limit of the request.
 * @returns A clause for {@link buildFailedReadResult}.
 */
function formatPageRequestFailure(
  failure: PageRequestFailure,
  requestTimeoutMs: number
): string {
  switch (failure.kind) {
    case "blocked-address":
      return "its address belongs to this machine or a private network, which Lys never reads."
    case "unresolvable-host":
      return "its host name could not be found."
    case "invalid-redirect":
      return `it redirected to an address Lys may not read. ${formatPageUrlProblem(failure.problem)}`
    case "too-many-redirects":
      return `it redirected more than ${MAXIMUM_PAGE_REDIRECTS} times.`
    case "timed-out":
      return `it did not load within ${requestTimeoutMs / MILLISECONDS_PER_SECOND} seconds.`
    case "transfer-failed":
      return `the connection failed (${failure.code}).`
    case "http-status":
      return `the server answered with HTTP status ${failure.status}.`
    case "unsupported-content-type":
      return `it is not a web page (${failure.mediaType ?? "no content type"}). Lys reads HTML and plain-text pages only.`
    case "unsupported-encoding":
      return `the server compressed it as ${failure.encoding}, which Lys cannot decode.`
  }
}

/**
 * Builds what the model reads about a page Lys read.
 *
 * @param page - Page Lys read.
 * @param extraction - Main text extracted from it.
 * @param focus - What the model wants to learn, or undefined.
 * @returns The page evidence, or why the page has nothing to read.
 */
function buildPageReadResult(
  page: PageResponse,
  extraction: PageExtractionResult,
  focus: string | undefined
): BuiltInToolResult {
  switch (extraction.status) {
    case "no-readable-text":
      return buildFailedReadResult(
        page.url,
        "the page has no readable text. It may need JavaScript to show its content, which Lys cannot run."
      )
    case "too-complex":
      return buildFailedReadResult(
        page.url,
        "the page is too large or too deeply nested for Lys to read."
      )
    case "extracted": {
      const passages = calculatePagePassages(extraction.article.blocks)
      const selection = selectPagePassages(passages, focus)
      const content = formatPageEvidence({
        url: page.url,
        article: extraction.article,
        selection,
        isTruncated: page.isTruncated
      })
      return Object.freeze({ status: "succeeded", content })
    }
  }
}

/**
 * Reads one page and builds what the model reads about it.
 *
 * @param input - Page and focus.
 * @param abortSignal - Stops the read.
 * @param dependencies - Lookup, address rule, and time limit.
 * @returns The page evidence, or why the page could not be read.
 * @throws The abort reason once `abortSignal` aborts, and any failure Lys
 * does not recognize.
 */
async function runPageRead(
  input: PageReadInput,
  abortSignal: AbortSignal,
  dependencies: PageRequestDependencies
): Promise<BuiltInToolResult> {
  const request = await getWebPage(input.url, abortSignal, dependencies)
  if (request.status === "failed") {
    return buildFailedReadResult(
      input.url,
      formatPageRequestFailure(request.failure, dependencies.requestTimeoutMs)
    )
  }
  abortSignal.throwIfAborted()
  const extraction = extractPageArticle(request.page)
  return buildPageReadResult(request.page, extraction, input.focus)
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
 * Owns the page request settings to read one public web page per call and
 * give the model its main text to cite, never reaching this machine or a
 * private network.
 *
 * @remarks Implements {@link BuiltInTool}. Parsing checks the URL by the
 * page URL rules before the person is asked; a run requests the page,
 * following checked redirects, extracts its main text, keeps the passages
 * that fit, and frames them as untrusted page content. Every failure the
 * model can act on becomes its result; only a defect rejects. Owns no
 * resource; each run opens and closes its own connections. Concurrency
 * model: reentrant.
 */
export default class ReadPageTool implements BuiltInTool {
  /** Lookup, address rule, and time limit of every request. */
  readonly #pageRequestDependencies: PageRequestDependencies

  /**
   * Creates the tool without contacting anything.
   *
   * @param pageRequestDependencies - Lookup, address rule, and time limit,
   * lent for the tool's lifetime.
   */
  public constructor(pageRequestDependencies: PageRequestDependencies) {
    this.#pageRequestDependencies = pageRequestDependencies
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
    const dependencies = this.#pageRequestDependencies
    return Object.freeze({
      status: "parsed",
      runToolCall: (abortSignal: AbortSignal) =>
        runPageRead(parsed.input, abortSignal, dependencies)
    })
  }
}
