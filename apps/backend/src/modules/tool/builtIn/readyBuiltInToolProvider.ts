import type {
  BuiltInTool,
  TurnToolLookup,
  BuiltInToolProvider
} from "./builtInTool"

/**
 * Owns a tool that needs nothing per turn to give it to every turn.
 *
 * @remarks Implements {@link BuiltInToolProvider}: every lookup is
 * `ready` with the same tool, so the tool must be reentrant. Owns no
 * resource. Concurrency model: reentrant.
 */
export default class ReadyBuiltInToolProvider implements BuiltInToolProvider {
  /** Lookup every turn gets. */
  readonly #lookup: TurnToolLookup

  /**
   * Creates the provider without contacting anything.
   *
   * @param tool - Reentrant tool every turn runs, lent for the provider's
   * lifetime.
   */
  public constructor(tool: BuiltInTool) {
    this.#lookup = Object.freeze({ status: "ready", tool })
  }

  /**
   * Implements {@link BuiltInToolProvider.findTurnTool}.
   *
   * @returns The interface-defined outcome; always `ready`.
   */
  public findTurnTool(): Promise<TurnToolLookup> {
    return Promise.resolve(this.#lookup)
  }
}
