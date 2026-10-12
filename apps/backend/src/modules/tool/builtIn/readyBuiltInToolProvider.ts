import type {
  BuiltInTool,
  BuiltInToolPreparation,
  BuiltInToolProvider
} from "./builtInTool"

/**
 * Owns a tool that needs nothing per turn to give it to every turn.
 *
 * @remarks Implements {@link BuiltInToolProvider}: every preparation is
 * `ready` with the same tool, so the tool must be reentrant. Owns no
 * resource. Concurrency model: reentrant.
 */
export default class ReadyBuiltInToolProvider implements BuiltInToolProvider {
  /** Preparation every turn gets. */
  readonly #preparation: BuiltInToolPreparation

  /**
   * Creates the provider without contacting anything.
   *
   * @param tool - Reentrant tool every turn runs, lent for the provider's
   * lifetime.
   */
  public constructor(tool: BuiltInTool) {
    this.#preparation = Object.freeze({ status: "ready", tool })
  }

  /**
   * Implements {@link BuiltInToolProvider.prepareTool}.
   *
   * @returns The interface-defined outcome; always `ready`.
   */
  public prepareTool(): Promise<BuiltInToolPreparation> {
    return Promise.resolve(this.#preparation)
  }
}
