import type { ToolDefinition } from "@lys/share"
import {
  calculateRankingScores,
  listRankingWords
} from "../../utils/search/textRanking"

/** Most tools one search of the catalog lists, inclusive. */
export const MAXIMUM_LISTED_TOOL_COUNT = 8

/** Most tools the tool keeper recommends in one search, inclusive. */
export const MAXIMUM_RECOMMENDED_TOOL_COUNT = 5

/** Matches the punctuation that joins the words of a tool name. */
const TOOL_NAME_JOINER_PATTERN = /[_.-]+/g

/** The tools one search of the catalog found. */
export type ToolMatchList = Readonly<{
  /**
   * First matching tools, best match first, ties in offer order; at most
   * {@link MAXIMUM_LISTED_TOOL_COUNT}.
   */
  matches: readonly ToolDefinition[]
  /** Number of all matching tools, the ones not listed included. */
  matchCount: number
}>

/** Outcome of recommending one tool. */
export type ToolRecommendation =
  | Readonly<{
      /** The tool is recommended now. */
      status: "recommended"
      /** Number of tools recommended so far, this one included. */
      recommendedCount: number
    }>
  | Readonly<{
      /** The tool was recommended before; nothing changed. */
      status: "already-recommended"
    }>
  | Readonly<{
      /** No tool of the turn has the name; nothing changed. */
      status: "unknown"
    }>
  | Readonly<{
      /**
       * {@link MAXIMUM_RECOMMENDED_TOOL_COUNT} tools are recommended already;
       * nothing changed.
       */
      status: "full"
    }>

/** Tools of a search that found nothing. */
const NO_MATCHED_TOOLS: readonly ToolDefinition[] = Object.freeze([])

/** Shared list of a search that found nothing. */
const NO_TOOL_MATCHES: ToolMatchList = Object.freeze({
  matches: NO_MATCHED_TOOLS,
  matchCount: 0
})

/**
 * Builds the text a tool is ranked by.
 *
 * @param definition - Definition of the tool.
 * @returns Its name with the words split, its group, and its description,
 * so a query finds `send_email` by `email`.
 */
function buildRankedToolText(definition: ToolDefinition): string {
  const nameWords = definition.name.replaceAll(TOOL_NAME_JOINER_PATTERN, " ")
  return `${nameWords} ${definition.group} ${definition.description}`
}

/**
 * Owns the tools one asking turn may offer, as the tool keeper searches
 * them and recommends some of them during one search.
 *
 * @remarks Invariant: every recommended name is the name of one of the
 * catalog's tools, recommended once, and at most
 * {@link MAXIMUM_RECOMMENDED_TOOL_COUNT} are. A search reads the catalog and
 * changes nothing; recommendations only grow. Created per search and
 * dropped with it; holds no resource. Every list it returns is frozen.
 * Concurrency model: single-owner, used by one search on the backend's
 * event loop; each operation is one synchronous step.
 */
export default class ToolCatalog {
  /** Tools of the asking turn, in offer order. */
  readonly #tools: readonly ToolDefinition[]

  /** Text each tool is ranked by, in offer order. */
  readonly #rankedTexts: readonly string[]

  /** Names of the recommended tools, in the order they were recommended. */
  readonly #recommendedNames = new Set<string>()

  /**
   * Creates the catalog of one search.
   *
   * @param tools - Definitions of the asking turn's tools, each name once,
   * in offer order; the list is copied.
   */
  public constructor(tools: readonly ToolDefinition[]) {
    this.#tools = Object.freeze([...tools])
    this.#rankedTexts = Object.freeze(this.#tools.map(buildRankedToolText))
  }

  /**
   * Answers whether the asking turn has a tool.
   *
   * @param name - Tool name, compared exactly.
   * @returns True when one of the catalog's tools has the name.
   */
  public hasTool(name: string): boolean {
    return this.#tools.some((tool) => tool.name === name)
  }

  /**
   * Lists the tools that best match a query.
   *
   * @param query - Words that describe what a tool must do.
   * @returns The frozen first matches and the number of all matches, ranked
   * with BM25 over each tool's name words, group, and description, ignoring
   * case; nothing when the query holds no word or no tool holds one of its
   * words.
   */
  public listToolMatches(query: string): ToolMatchList {
    const queryWords = [...new Set(listRankingWords(query))]
    if (queryWords.length === 0 || this.#tools.length === 0)
      return NO_TOOL_MATCHES
    const scores = calculateRankingScores(this.#rankedTexts, queryWords)
    const ranked = this.#tools
      .map((tool, index) => ({ tool, index, score: scores[index] ?? 0 }))
      .filter((match) => match.score > 0)
      .toSorted(
        (first, second) =>
          second.score - first.score || first.index - second.index
      )
    const matches = Object.freeze(
      ranked.slice(0, MAXIMUM_LISTED_TOOL_COUNT).map((match) => match.tool)
    )
    return Object.freeze({ matches, matchCount: ranked.length })
  }

  /**
   * Recommends one of the asking turn's tools.
   *
   * @param name - Tool name, compared exactly.
   * @returns `recommended` with the count so far; `already-recommended`,
   * `unknown`, or `full` when nothing changed, checked in that order.
   */
  public recommendTool(name: string): ToolRecommendation {
    if (this.#recommendedNames.has(name))
      return Object.freeze({ status: "already-recommended" })
    if (!this.hasTool(name)) return Object.freeze({ status: "unknown" })
    if (this.#recommendedNames.size >= MAXIMUM_RECOMMENDED_TOOL_COUNT)
      return Object.freeze({ status: "full" })
    this.#recommendedNames.add(name)
    return Object.freeze({
      status: "recommended",
      recommendedCount: this.#recommendedNames.size
    })
  }

  /**
   * Lists the recommended tools.
   *
   * @returns A frozen list of their names, in the order they were
   * recommended; later recommendations leave it as it was.
   */
  public listRecommendedToolNames(): readonly string[] {
    return Object.freeze([...this.#recommendedNames])
  }
}
