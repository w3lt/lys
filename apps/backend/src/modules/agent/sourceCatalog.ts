import type { ConversationSource } from "@lys/share"
import type { WebSourceCandidate } from "../tool/builtIn/builtInTool"

/**
 * Owns the numbered sources of one conversation during one turn to give each
 * URL one number for the whole conversation.
 *
 * @remarks Invariant: a URL keeps the number it was first given, and a new
 * URL gets the number after the highest one given so far. Seeded with the
 * sources the conversation stored before the turn; the sources it numbers
 * during the turn are stored with the tool calls that show them, so a later
 * turn is seeded with every number a stored result shows. A number given to
 * a call whose result is never stored, because the reply ended first, leaves
 * a gap that the next turn does not fill. Holds no resource. Concurrency
 * model: single-owner, used by one reply on the backend's event loop; calls
 * that run in parallel number their sources one after another, each in one
 * synchronous step.
 */
export default class SourceCatalog {
  /** Every numbered source by URL. */
  readonly #sourcesByUrl: Map<string, ConversationSource>
  /** Number the next new URL gets. */
  #nextNumber: number

  /**
   * Creates the catalog of one turn.
   *
   * @param storedSources - Sources the conversation stored before the turn,
   * each URL once under a distinct number; copied.
   */
  public constructor(storedSources: readonly ConversationSource[]) {
    this.#sourcesByUrl = new Map(
      storedSources.map((source) => [source.url, source])
    )
    this.#nextNumber =
      Math.max(0, ...storedSources.map((source) => source.number)) + 1
  }

  /**
   * Numbers the sources a tool result is about to show.
   *
   * @param candidates - Sources in the result's order.
   * @returns Each candidate numbered, in the same order: a URL numbered
   * before keeps its source, stored title included, and a new URL becomes a
   * new source under the next number. A URL given twice gets one number.
   */
  public addWebSources(
    candidates: readonly WebSourceCandidate[]
  ): readonly ConversationSource[] {
    return Object.freeze(
      candidates.map((candidate) => this.#addWebSource(candidate))
    )
  }

  /**
   * Numbers one source.
   *
   * @param candidate - Source to number.
   * @returns The source already numbered for its URL, or the new one.
   */
  #addWebSource(candidate: WebSourceCandidate): ConversationSource {
    const knownSource = this.#sourcesByUrl.get(candidate.url)
    if (knownSource !== undefined) return knownSource
    const source: ConversationSource = Object.freeze({
      number: this.#nextNumber,
      url: candidate.url,
      title: candidate.title
    })
    this.#sourcesByUrl.set(source.url, source)
    this.#nextNumber += 1
    return source
  }
}
