import type { ToolDefinition } from "@lys/share"
import {
  calculateRankingScores,
  listRankingWords
} from "../../utils/search/textRanking"

/** Most tools one search of the catalog lists, inclusive. */
export const MAXIMUM_LISTED_TOOL_COUNT = 8

/** Most tools the tool keeper recommends in one search, inclusive. */
export const MAXIMUM_RECOMMENDED_TOOL_COUNT = 5

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

/**
 * Builds the text a tool is ranked by.
 *
 * @param definition - Definition of the tool.
 * @returns Its name as one word, with each `-` written as `_`, the words of
 * its name when the name holds more than one, its group, and its
 * description, so a query finds `send_email` by `email` and by
 * `send_email`, `createIssue` by `issue` and by `createIssue`, and
 * `send-email` as it finds `send_email`.
 */
function buildRankedToolText(definition: ToolDefinition): string {
  /** Matches a run of `_` or `-`, which splits `send_email`. */
  const separatorPattern = /[_-]+/g
  /**
   * Matches the place between a lowercase letter or digit and an uppercase
   * letter, which splits `createIssue`.
   */
  const wordStartPattern = /(?<=[a-z0-9])(?=[A-Z])/g
  /**
   * Matches the place before the last uppercase letter of a run that a
   * lowercase letter follows, which splits `XMLHttp` before `H`, unless
   * that letter is a plural `s` that no lowercase letter follows, so
   * `getURLs` and `listAPIsByOwner` keep `URLs` and `APIs` whole.
   */
  const acronymEndPattern = /(?<=[A-Z])(?=[A-Z](?!s(?![a-z]))[a-z])/g

  const { name } = definition
  // The word segmenter splits a name at `-` but keeps `_`, so the whole
  // name is ranked with `_` to stay one word.
  const wholeName = name.replaceAll("-", "_")
  const nameWords = name
    .replaceAll(separatorPattern, " ")
    .replaceAll(wordStartPattern, " ")
    .replaceAll(acronymEndPattern, " ")
  const rankedName =
    nameWords === name ? wholeName : `${wholeName} ${nameWords}`
  return `${rankedName} ${definition.group} ${definition.description}`
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
   * @param query - Words that describe what a tool must do, or a tool's
   * name; each word is searched as written, ignoring case.
   * @returns The frozen first matches and the number of all matches, ranked
   * with BM25 over each tool's name, the words of its name, its group, and
   * its description, ignoring case; nothing when the query holds no word or
   * no tool holds one of its words.
   */
  public listToolMatches(query: string): ToolMatchList {
    /** Tools of a search that found nothing. */
    const noMatchedTools: readonly ToolDefinition[] = Object.freeze([])
    /** List of a search that found nothing. */
    const noToolMatches: ToolMatchList = Object.freeze({
      matches: noMatchedTools,
      matchCount: 0
    })

    const queryWords = [...new Set(listRankingWords(query))]
    if (queryWords.length === 0 || this.#tools.length === 0)
      return noToolMatches
    const scores = calculateRankingScores(this.#rankedTexts, queryWords)
    // The sort is stable, so tools with equal scores stay in offer order.
    const ranked = this.#tools
      .map((tool, index) => ({ tool, score: scores[index] ?? 0 }))
      .filter((match) => match.score > 0)
      .toSorted((first, second) => second.score - first.score)
    const matches = Object.freeze(
      ranked.slice(0, MAXIMUM_LISTED_TOOL_COUNT).map((match) => match.tool)
    )
    return Object.freeze({ matches, matchCount: ranked.length })
  }

  /**
   * Adds one of the asking turn's tools to the recommended ones.
   *
   * @param name - Tool name, compared exactly.
   * @returns `recommended` with the count so far; `already-recommended`,
   * `unknown`, or `full` when nothing changed, checked in that order.
   */
  public addRecommendedTool(name: string): ToolRecommendation {
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
