import type {
  BuiltInTool,
  BuiltInToolProvider,
  TurnToolLookup
} from "../builtInTool"
import { sendVmoHealthCheck } from "./vmoHealth"

/** Lookup of every turn while vmo does not answer its health route. */
const PAGE_READER_NOT_READY: TurnToolLookup = Object.freeze({
  status: "unavailable",
  reason: "page-reader-not-ready"
})

/**
 * Owns the read-page tool to give it to a turn only while vmo, the page
 * reader the tool asks, answers its health route.
 *
 * @remarks Implements {@link BuiltInToolProvider}. Every lookup sends one
 * `GET /health` to vmo, so the tool list and each turn that offers the tool
 * see whether vmo runs now; a lookup takes at most the health time limit.
 * Owns no resource: each check opens and closes its own connection.
 * Concurrency model: reentrant.
 */
export default class ReadPageToolProvider implements BuiltInToolProvider {
  /** Lookup of every turn while vmo answers. */
  readonly #readyLookup: TurnToolLookup

  /** Origin of vmo, such as `http://127.0.0.1:8080`. */
  readonly #vmoOrigin: string

  /** Time limit of each health check, in milliseconds. */
  readonly #healthTimeoutMs: number

  /**
   * Creates the provider without contacting vmo.
   *
   * @param tool - Reentrant read-page tool, lent for the provider's lifetime.
   * @param vmoOrigin - Origin of the vmo the tool reads pages through.
   * @param healthTimeoutMs - Time limit of each health check, in
   * milliseconds.
   */
  public constructor(
    tool: BuiltInTool,
    vmoOrigin: string,
    healthTimeoutMs: number
  ) {
    this.#readyLookup = Object.freeze({ status: "ready", tool })
    this.#vmoOrigin = vmoOrigin
    this.#healthTimeoutMs = healthTimeoutMs
  }

  /**
   * Implements {@link BuiltInToolProvider.findTurnTool}.
   *
   * @returns The interface-defined outcome: `ready` with the tool when vmo
   * answers its health route with `200 OK` in time, otherwise `unavailable`
   * with `page-reader-not-ready`.
   */
  public async findTurnTool(): Promise<TurnToolLookup> {
    const health = await sendVmoHealthCheck(
      this.#vmoOrigin,
      this.#healthTimeoutMs
    )
    return health === "ready" ? this.#readyLookup : PAGE_READER_NOT_READY
  }
}
