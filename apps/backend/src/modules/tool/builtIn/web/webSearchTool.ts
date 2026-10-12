import { WEB_SEARCH_TOOL_NAME } from "@lys/protocol"
import {
  toolDefinitionSchema,
  type TavilyApiKey,
  type ToolDefinition
} from "@lys/share"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  ParsedBuiltInToolCall
} from "../builtInTool"
import { READ_PAGE_TOOL_NAME } from "./readPageTool"
import { formatSearchEvidence } from "./searchEvidence"
import {
  MAXIMUM_SEARCH_QUERY_LENGTH,
  MAXIMUM_SEARCH_RESULTS,
  sendTavilySearchRequest,
  type TavilySearchRequest
} from "./tavilyApi"
import {
  MAXIMUM_TAVILY_RESPONSE_BYTES,
  type TavilyRequestDependencies,
  type TavilyRequestFailure
} from "./tavilyRequest"

/** Milliseconds one search may take in production, connection and body included. */
export const WEB_SEARCH_TIMEOUT_MS = 15_000

/** Milliseconds in one second. */
const MILLISECONDS_PER_SECOND = 1_000

/** Bytes in one mebibyte. */
const BYTES_PER_MEBIBYTE = 1024 * 1024

/** Outcome of parsing a search's query. */
type SearchQueryResult =
  | Readonly<{
      /** The query can be sent. */
      status: "parsed"
      /** Trimmed query. */
      query: string
    }>
  | Readonly<{
      /** The query cannot be sent. */
      status: "invalid"
      /** Explanation the model reads. */
      message: string
    }>

/**
 * Builds the definition of the web search tool.
 *
 * @returns The validated, frozen definition: it reaches past this machine,
 * runs in the backend, and tells the model where queries go and its limits.
 */
export function buildWebSearchDefinition(): ToolDefinition {
  const timeoutSeconds = WEB_SEARCH_TIMEOUT_MS / MILLISECONDS_PER_SECOND
  return toolDefinitionSchema.parse({
    name: WEB_SEARCH_TOOL_NAME,
    description: `Search the web and return up to ${MAXIMUM_SEARCH_RESULTS} results, each with its title, URL, and a short snippet. Use it for current events, recent releases, or anything you have no URL for. Snippets are short and can be out of date: read a page with ${READ_PAGE_TOOL_NAME}, when that tool is offered, before you rely on it. The query is sent to Tavily, a search service outside this machine, so leave out names, contact details, and other personal details unless the message requires them. A search takes at most ${timeoutSeconds} seconds.`,
    group: "network",
    access: "network",
    runner: "backend",
    arguments: [
      {
        type: "string",
        name: "query",
        description: `What to search for, in a few words, at most ${MAXIMUM_SEARCH_QUERY_LENGTH} characters.`
      }
    ]
  })
}

/**
 * Parses the query argument of a search.
 *
 * @param query - Untrusted query value.
 * @returns The trimmed query, or an explanation when it is not text, is
 * blank, or is too long once trimmed.
 */
function parseSearchQuery(
  query: BuiltInToolCallArguments[string] | undefined
): SearchQueryResult {
  if (typeof query !== "string") {
    return Object.freeze({
      status: "invalid",
      message: "The query argument must be text."
    })
  }
  const trimmed = query.trim()
  if (trimmed === "") {
    return Object.freeze({ status: "invalid", message: "The query is empty." })
  }
  if (trimmed.length > MAXIMUM_SEARCH_QUERY_LENGTH) {
    return Object.freeze({
      status: "invalid",
      message: `The query is longer than ${MAXIMUM_SEARCH_QUERY_LENGTH} characters.`
    })
  }
  return Object.freeze({ status: "parsed", query: trimmed })
}

/**
 * Formats why Tavily answered with an HTTP error status.
 *
 * @param status - HTTP status other than 2xx or 3xx.
 * @param retryAfterSeconds - Seconds Tavily asked to wait, or undefined.
 * @returns A clause after "Lys could not search the web:".
 */
function formatTavilyStatusFailure(
  status: number,
  retryAfterSeconds: number | undefined
): string {
  if (status === 401 || status === 403) {
    return "Tavily rejected the API key. The person can check it in Settings → Secrets."
  }
  if (status === 429) {
    const wait =
      retryAfterSeconds === undefined
        ? "later"
        : `in ${retryAfterSeconds} seconds`
    return `Tavily is limiting how often Lys can search. Try again ${wait}.`
  }
  if (status === 432 || status === 433) {
    return "the Tavily plan's search credits are used up."
  }
  if (status >= 400 && status <= 499) {
    return `Tavily refused the search request (HTTP ${status}).`
  }
  return `Tavily answered with HTTP status ${status}.`
}

/**
 * Formats why a search gave no results.
 *
 * @param failure - Recognized request failure.
 * @param requestTimeoutMs - Time limit of the request.
 * @returns A clause after "Lys could not search the web:". It never holds
 * Tavily's own text or the key.
 */
function formatTavilyFailure(
  failure: TavilyRequestFailure,
  requestTimeoutMs: number
): string {
  switch (failure.kind) {
    case "http-status":
      return formatTavilyStatusFailure(
        failure.status,
        failure.retryAfterSeconds
      )
    case "redirected":
      return "Tavily answered with a redirect, which Lys does not follow."
    case "timed-out":
      return `the search did not finish within ${requestTimeoutMs / MILLISECONDS_PER_SECOND} seconds.`
    case "unreachable":
      return `Tavily could not be reached (${failure.code}).`
    case "unresolvable-host":
      return "Tavily's host name could not be found."
    case "blocked-address":
      return "Tavily's address resolved to this machine or a private network, so Lys did not connect."
    case "too-large":
      return `Tavily's answer was larger than ${MAXIMUM_TAVILY_RESPONSE_BYTES / BYTES_PER_MEBIBYTE} MiB.`
    case "unreadable":
      return "Tavily's answer could not be read."
  }
}

/**
 * Runs one search and builds what the model reads about it.
 *
 * @param searchRequest - Query and key.
 * @param abortSignal - Stops the search.
 * @param dependencies - Origin, address rule, and time limit.
 * @returns The search evidence, which says plainly when nothing was found, or
 * why the search failed.
 * @throws The abort reason once `abortSignal` aborts, and any failure Lys
 * does not recognize.
 */
async function runWebSearch(
  searchRequest: TavilySearchRequest,
  abortSignal: AbortSignal,
  dependencies: TavilyRequestDependencies
): Promise<BuiltInToolResult> {
  const outcome = await sendTavilySearchRequest(
    searchRequest,
    abortSignal,
    dependencies
  )
  if (outcome.status === "failed") {
    const reason = formatTavilyFailure(
      outcome.failure,
      dependencies.requestTimeoutMs
    )
    return Object.freeze({
      status: "failed",
      content: `Lys could not search the web: ${reason}`
    })
  }
  const content = formatSearchEvidence({
    query: searchRequest.query,
    results: outcome.results
  })
  return Object.freeze({ status: "succeeded", content })
}

/**
 * Owns one Tavily API key and the request settings to search the web for
 * the calls of one turn and give the model untrusted results to choose
 * pages from.
 *
 * @remarks Implements {@link BuiltInTool}. Created for each turn with the key
 * the turn started with, so every search of the turn uses that key. Parsing
 * checks the query before the person is asked; a run sends one basic search
 * of at most five results and frames them as untrusted results. Every
 * failure the model can act on becomes its result; only a defect rejects.
 * Owns no resource; each run opens and closes its own connection.
 * Concurrency model: reentrant.
 */
export default class WebSearchTool implements BuiltInTool {
  /** Key every search is sent with; a secret, never part of a result. */
  readonly #apiKey: TavilyApiKey
  /** Origin, address rule, and time limit of every request. */
  readonly #requestDependencies: TavilyRequestDependencies

  /**
   * Creates the tool without contacting anything.
   *
   * @param apiKey - Key the turn started with.
   * @param requestDependencies - Origin, address rule, and time limit, lent
   * for the tool's lifetime.
   */
  public constructor(
    apiKey: TavilyApiKey,
    requestDependencies: TavilyRequestDependencies
  ) {
    this.#apiKey = apiKey
    this.#requestDependencies = requestDependencies
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for web searches.
   *
   * @param callArguments - The interface-defined argument values: `query`.
   * @returns The interface-defined outcome; `invalid` for a query that is not
   * text, is blank, or is longer than 400 characters once trimmed.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    const parsed = parseSearchQuery(callArguments.query)
    if (parsed.status === "invalid") return parsed
    const searchRequest: TavilySearchRequest = Object.freeze({
      query: parsed.query,
      apiKey: this.#apiKey
    })
    const dependencies = this.#requestDependencies
    return Object.freeze({
      status: "parsed",
      runToolCall: (abortSignal: AbortSignal) =>
        runWebSearch(searchRequest, abortSignal, dependencies)
    })
  }
}
