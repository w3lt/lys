import type {
  BuiltInToolPreparation,
  BuiltInToolProvider
} from "../../../src/modules/tool/builtIn/builtInTool"

/**
 * Owns a fixed preparation to stand in for a backend tool's provider in route
 * tests, counting how often it is asked.
 *
 * @remarks Implements {@link BuiltInToolProvider}: every preparation resolves
 * with the preparation given at creation. Concurrency model: single-owner, in
 * one test.
 */
export class ScriptedBuiltInToolProvider implements BuiltInToolProvider {
  /** Preparation every call gives. */
  readonly #preparation: BuiltInToolPreparation
  /** Number of preparations asked for so far. */
  #preparationCount = 0

  /**
   * Creates the provider.
   *
   * @param preparation - Preparation every call gives; frozen here.
   */
  public constructor(preparation: BuiltInToolPreparation) {
    this.#preparation = Object.freeze(preparation)
  }

  /**
   * Number of preparations asked for so far.
   *
   * @returns The count.
   */
  public get preparationCount(): number {
    return this.#preparationCount
  }

  /**
   * Implements {@link BuiltInToolProvider.prepareTool}.
   *
   * @returns The interface-defined outcome: the fixed preparation.
   */
  public prepareTool(): Promise<BuiltInToolPreparation> {
    this.#preparationCount += 1
    return Promise.resolve(this.#preparation)
  }
}
