import { toolDefinitionSchema } from "@lys/share"
import { listRankingWords } from "../../utils/search/textRanking"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  ParsedBuiltInToolCall,
  TurnBuiltInTool
} from "../tool/builtIn/builtInTool"
import type ToolCatalog from "./toolCatalog"
import {
  MAXIMUM_LISTED_TOOL_COUNT,
  MAXIMUM_RECOMMENDED_TOOL_COUNT,
  type ToolMatchList
} from "./toolCatalog"

/** Name the tool keeper calls the tool by that searches the turn's tools. */
export const SEARCH_TOOLS_TOOL_NAME = "search_tools"

/** Name the tool keeper calls the tool by that recommends one tool. */
export const RECOMMEND_TOOL_TOOL_NAME = "recommend_tool"

/** Inclusive maximum length of a trimmed tool query, in UTF-16 code units. */
const MAXIMUM_TOOL_QUERY_LENGTH = 200

/**
 * Builds a parsed call that runs synchronously once it starts.
 *
 * @param run - Does the call's work and builds its result.
 * @returns The parsed call: each run rejects with the abort reason when the
 * signal already aborted, without doing any work, and otherwise gives
 * `run`'s result.
 */
function buildParsedCall(run: () => BuiltInToolResult): ParsedBuiltInToolCall {
  return Object.freeze({
    status: "parsed",
    runToolCall: ({ abortSignal }) =>
      new Promise<BuiltInToolResult>((resolve) => {
        abortSignal.throwIfAborted()
        resolve(run())
      })
  })
}

/**
 * Builds a result the model reads as a success.
 *
 * @param content - Output the model reads.
 * @returns The frozen result, showing no sources.
 */
function buildSucceededResult(content: string): BuiltInToolResult {
  /** Sources a tool keeper tool's result shows: none. */
  const noSources = Object.freeze([])

  return Object.freeze({ status: "succeeded", content, sources: noSources })
}

/**
 * Formats a tool's description for a search's listing.
 *
 * @param description - Description of the tool.
 * @returns The description on one line, each whitespace run as one space,
 * trimmed, and, when longer than 200 UTF-16 code units, cut to 200 with an
 * ellipsis as the last one, never splitting a surrogate pair.
 */
function formatListedDescription(description: string): string {
  /** Most UTF-16 code units of a description a search shows, inclusive. */
  const maximumListedDescriptionLength = 200
  /** Marks a description cut to fit a search's listing. */
  const cutMark = "…"
  /** Matches one run of whitespace, line breaks included. */
  const whitespaceRunPattern = /\s+/g
  /** Matches a high surrogate left alone at the end of a cut text. */
  const trailingHighSurrogatePattern = /[\uD800-\uDBFF]$/

  const oneLine = description.replaceAll(whitespaceRunPattern, " ").trim()
  if (oneLine.length <= maximumListedDescriptionLength) return oneLine
  const cut = oneLine
    .slice(0, maximumListedDescriptionLength - cutMark.length)
    .replace(trailingHighSurrogatePattern, "")
  return `${cut}${cutMark}`
}

/**
 * Formats what a search found.
 *
 * @param query - Trimmed query of the search.
 * @param result - The matches and their count.
 * @returns One line per listed tool under a heading, then how many more
 * match when there are more; or a sentence saying nothing matched.
 */
function formatToolMatches(query: string, result: ToolMatchList): string {
  if (result.matchCount === 0)
    return `No tool matches "${query}". Search with other words, or recommend nothing if no tool fits.`
  const lines = [
    `Tools that match "${query}", best first:`,
    ...result.matches.map(
      (tool) => `- ${tool.name}: ${formatListedDescription(tool.description)}`
    )
  ]
  const moreCount = result.matchCount - result.matches.length
  if (moreCount > 0)
    lines.push(
      `${moreCount} more ${moreCount === 1 ? "tool matches" : "tools match"}; search with other words to narrow the list.`
    )
  return lines.join("\n")
}

/**
 * Runs one `recommend_tool` call.
 *
 * @param name - Name of the tool.
 * @param catalog - Catalog of the search, which gains the recommendation.
 * @returns The result the model reads: a success that counts the
 * recommendations, or says the tool was recommended before; a failure for a
 * name no tool of the turn has, or once the most tools are recommended.
 */
function runRecommendTool(
  name: string,
  catalog: ToolCatalog
): BuiltInToolResult {
  const outcome = catalog.addRecommendedTool(name)
  switch (outcome.status) {
    case "recommended":
      return buildSucceededResult(
        `Recommended ${name}: ${outcome.recommendedCount} of at most ${MAXIMUM_RECOMMENDED_TOOL_COUNT} tools.`
      )
    case "already-recommended":
      return buildSucceededResult(`${name} is already recommended.`)
    case "unknown":
      return Object.freeze({
        status: "failed",
        content: formatUnknownToolMessage(name)
      })
    case "full":
      return Object.freeze({
        status: "failed",
        content: `You already recommended ${MAXIMUM_RECOMMENDED_TOOL_COUNT} tools, the most for one search. Finish with one short sentence.`
      })
  }
}

/**
 * Formats what the tool keeper reads for a name no tool of the turn has.
 *
 * @param name - Name it gave.
 * @returns The sentence telling it to use a listed name.
 */
function formatUnknownToolMessage(name: string): string {
  return `No tool is named "${name}". Recommend a name ${SEARCH_TOOLS_TOOL_NAME} listed, exactly as it listed it.`
}

/**
 * Answers whether a search query can be searched for.
 *
 * @param query - Trimmed query of a `search_tools` call.
 * @returns True when the query holds 1 to {@link MAXIMUM_TOOL_QUERY_LENGTH}
 * UTF-16 code units and at least one word.
 */
function isSearchableQuery(query: string): boolean {
  return (
    query.length > 0 &&
    query.length <= MAXIMUM_TOOL_QUERY_LENGTH &&
    listRankingWords(query).length > 0
  )
}

/**
 * Searches the asking turn's tools for the tool keeper.
 *
 * @remarks Each parsed call searches its catalog once, when it runs, and
 * changes nothing. Owns no resource; the catalog is lent for the search.
 * Concurrency model: single-owner, as its catalog is: used by one search on
 * the backend's event loop, each parsed call running in one synchronous
 * step.
 */
class SearchToolsTool implements BuiltInTool {
  /** Tools of the asking turn; lent for the search. */
  readonly #catalog: ToolCatalog

  /**
   * Keeps the search's catalog without reading it.
   * @param catalog - Catalog of the search.
   */
  public constructor(catalog: ToolCatalog) {
    this.#catalog = catalog
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for a search.
   * @param callArguments - The interface-defined argument values: `query`,
   * a string.
   * @returns `invalid` for a query that is blank, longer than
   * {@link MAXIMUM_TOOL_QUERY_LENGTH} after trimming, or without a word;
   * otherwise `parsed`, whose run lists the matching tools.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    /** Copy shown for a query that is blank, too long, or without words. */
    const invalidQueryMessage = `The query must be 1 to ${MAXIMUM_TOOL_QUERY_LENGTH} characters long after trimming and hold at least one word.`

    const value = callArguments["query"]
    const query = typeof value === "string" ? value.trim() : ""
    if (!isSearchableQuery(query))
      return Object.freeze({ status: "invalid", message: invalidQueryMessage })
    return buildParsedCall(() =>
      buildSucceededResult(
        formatToolMatches(query, this.#catalog.listToolMatches(query))
      )
    )
  }
}

/**
 * Records the tool keeper's recommendations of the asking turn's tools.
 *
 * @remarks Each parsed call recommends once, when it runs. Owns no
 * resource; the catalog is lent for the search. Concurrency model:
 * single-owner, as its catalog is: used by one search on the backend's
 * event loop, each parsed call running in one synchronous step.
 */
class RecommendToolTool implements BuiltInTool {
  /** Tools of the asking turn and the recommendations; lent for the search. */
  readonly #catalog: ToolCatalog

  /**
   * Keeps the search's catalog without reading it.
   * @param catalog - Catalog of the search.
   */
  public constructor(catalog: ToolCatalog) {
    this.#catalog = catalog
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for a recommendation.
   * @param callArguments - The interface-defined argument values: `name`, a
   * string.
   * @returns `invalid` for a name no tool of the turn has; otherwise
   * `parsed`, whose run recommends the tool.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    const value = callArguments["name"]
    const name = typeof value === "string" ? value : ""
    if (!this.#catalog.hasTool(name))
      return Object.freeze({
        status: "invalid",
        message: formatUnknownToolMessage(name)
      })
    return buildParsedCall(() => runRecommendTool(name, this.#catalog))
  }
}

/**
 * Builds the tools the tool keeper searches and recommends with during one
 * search.
 *
 * @param catalog - Catalog of the search, lent for it.
 * @returns `search_tools`, then `recommend_tool`, frozen: each in the
 * `agents` group, reading this machine, run by the backend, and running
 * without the person's approval, as they read and recommend only the tools
 * the asking turn may already offer.
 */
export function buildToolKeeperTools(
  catalog: ToolCatalog
): readonly TurnBuiltInTool[] {
  return Object.freeze([
    buildSearchToolsEntry(catalog),
    buildRecommendToolEntry(catalog)
  ])
}

/**
 * Builds the toolset entry of `search_tools`.
 *
 * @param catalog - Catalog of the search, lent for it.
 * @returns The frozen entry, whose tool searches the catalog and runs
 * without approval.
 */
function buildSearchToolsEntry(catalog: ToolCatalog): TurnBuiltInTool {
  /** The query argument of `search_tools`. */
  const queryArgument = Object.freeze({
    type: "string",
    name: "query",
    description: `A few words that describe what the tool must do, such as "read web page"; 1 to ${MAXIMUM_TOOL_QUERY_LENGTH} characters.`
  })
  /** Arguments of `search_tools`. */
  const searchToolsArguments = Object.freeze([queryArgument])
  /** Definition of the tool that searches the asking turn's tools. */
  const definition = toolDefinitionSchema.parse({
    name: SEARCH_TOOLS_TOOL_NAME,
    description: `Search the tools of the asking agent's turn by what they do. Lists up to ${MAXIMUM_LISTED_TOOL_COUNT} tools that best match the words, each with its name and description, and says how many more match.`,
    group: "agents",
    access: "reads",
    runner: "backend",
    arguments: searchToolsArguments
  })

  const tool = new SearchToolsTool(catalog)
  return Object.freeze({ definition, tool, runsWithoutApproval: true })
}

/**
 * Builds the toolset entry of `recommend_tool`.
 *
 * @param catalog - Catalog of the search, lent for it.
 * @returns The frozen entry, whose tool recommends the catalog's tools and
 * runs without approval.
 */
function buildRecommendToolEntry(catalog: ToolCatalog): TurnBuiltInTool {
  /** The name argument of `recommend_tool`. */
  const nameArgument = Object.freeze({
    type: "string",
    name: "name",
    description: `Exact name of the tool, as ${SEARCH_TOOLS_TOOL_NAME} listed it.`
  })
  /** Arguments of `recommend_tool`. */
  const recommendToolArguments = Object.freeze([nameArgument])
  /** Definition of the tool that recommends one tool. */
  const definition = toolDefinitionSchema.parse({
    name: RECOMMEND_TOOL_TOOL_NAME,
    description: `Recommend one tool that ${SEARCH_TOOLS_TOOL_NAME} listed and that fits the asking agent's need. Recommend each fitting tool once, at most ${MAXIMUM_RECOMMENDED_TOOL_COUNT} tools.`,
    group: "agents",
    access: "reads",
    runner: "backend",
    arguments: recommendToolArguments
  })

  const tool = new RecommendToolTool(catalog)
  return Object.freeze({ definition, tool, runsWithoutApproval: true })
}
