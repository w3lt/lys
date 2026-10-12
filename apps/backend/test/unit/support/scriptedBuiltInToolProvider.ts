import type {
  TurnToolLookup,
  BuiltInToolProvider
} from "../../../src/modules/tool/builtIn/builtInTool"

/**
 * Owns a fixed lookup to stand in for a backend tool's provider in route
 * tests, counting how often it is asked.
 *
 * @remarks Implements {@link BuiltInToolProvider}: every lookup resolves
 * with the lookup given at creation. Concurrency model: single-owner, in
 * one test.
 */
export class ScriptedBuiltInToolProvider implements BuiltInToolProvider {
  /** Lookup every call gives. */
  readonly #lookup: TurnToolLookup
  /** Number of lookups asked for so far. */
  #lookupCount = 0

  /**
   * Creates the provider.
   *
   * @param lookup - Lookup every call gives; frozen here.
   */
  public constructor(lookup: TurnToolLookup) {
    this.#lookup = Object.freeze(lookup)
  }

  /**
   * Number of lookups asked for so far.
   *
   * @returns The count.
   */
  public get lookupCount(): number {
    return this.#lookupCount
  }

  /**
   * Implements {@link BuiltInToolProvider.findTurnTool}.
   *
   * @returns The interface-defined outcome: the fixed lookup.
   */
  public findTurnTool(): Promise<TurnToolLookup> {
    this.#lookupCount += 1
    return Promise.resolve(this.#lookup)
  }
}
