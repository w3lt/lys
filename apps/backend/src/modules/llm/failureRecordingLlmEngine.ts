import type { ModelLoadConfiguration } from "@lys/share"
import type { LlmEngine } from "./llmEngine"
import type {
  DownloadedLlmModel,
  LoadedLlmModelInstance
} from "./llmRuntimeTypes"

/**
 * Forwards one model operation's engine calls while recording whether any rejected.
 *
 * @remarks Owns one failure flag for the lifetime of a single queued model
 * operation and borrows the engine, which remains owned by the runtime service.
 * The flag only changes from unrecorded to recorded. Results and rejections are
 * forwarded unchanged; a synchronous throw from the engine is forwarded as a
 * rejection. Concurrency model: single-owner; the runtime service creates one
 * instance per accepted operation and discards it when that operation settles.
 */
export default class FailureRecordingLlmEngine implements LlmEngine {
  /** Borrowed engine that performs every forwarded call. */
  readonly #llmEngine: LlmEngine

  /** Whether any forwarded call has rejected since construction. */
  #hasRecordedFailure = false

  /**
   * Creates a recorder with no recorded failure.
   *
   * @param llmEngine - Borrowed engine whose calls are forwarded.
   */
  public constructor(llmEngine: LlmEngine) {
    this.#llmEngine = llmEngine
  }

  /**
   * Whether any forwarded engine call has rejected.
   *
   * @returns `true` once any call rejected; it never returns to `false`.
   */
  public get hasRecordedFailure(): boolean {
    return this.#hasRecordedFailure
  }

  /**
   * Implements {@link LlmEngine.listDownloadedLlmModels} by forwarding.
   *
   * @returns The interface-defined snapshot from the borrowed engine.
   * @throws The borrowed engine's failure, after recording it.
   */
  public async listDownloadedLlmModels(): Promise<
    readonly DownloadedLlmModel[]
  > {
    return await this.#handleLlmEngineCall(
      async () => await this.#llmEngine.listDownloadedLlmModels()
    )
  }

  /**
   * Implements {@link LlmEngine.listLoadedLlmModelInstances} by forwarding.
   *
   * @returns The interface-defined snapshot from the borrowed engine.
   * @throws The borrowed engine's failure, after recording it.
   */
  public async listLoadedLlmModelInstances(): Promise<
    readonly LoadedLlmModelInstance[]
  > {
    return await this.#handleLlmEngineCall(
      async () => await this.#llmEngine.listLoadedLlmModelInstances()
    )
  }

  /**
   * Implements {@link LlmEngine.loadLlmModel} by forwarding.
   *
   * @param modelKeyOrAlias - Interface-defined engine model selection.
   * @param loadConfiguration - Interface-defined load settings, forwarded unchanged.
   * @returns The interface-defined identity from the borrowed engine.
   * @throws The borrowed engine's failure, after recording it.
   */
  public async loadLlmModel(
    modelKeyOrAlias: string,
    loadConfiguration: ModelLoadConfiguration
  ): Promise<LoadedLlmModelInstance> {
    return await this.#handleLlmEngineCall(
      async () =>
        await this.#llmEngine.loadLlmModel(modelKeyOrAlias, loadConfiguration)
    )
  }

  /**
   * Implements {@link LlmEngine.stopLoadedLlmModelInstance} by forwarding.
   *
   * @param modelIdentifier - Interface-defined loaded-instance identifier.
   * @returns A promise resolving after the borrowed engine acknowledges the stop.
   * @throws The borrowed engine's failure, after recording it.
   */
  public async stopLoadedLlmModelInstance(
    modelIdentifier: string
  ): Promise<void> {
    await this.#handleLlmEngineCall(
      async () =>
        await this.#llmEngine.stopLoadedLlmModelInstance(modelIdentifier)
    )
  }

  /**
   * Performs one forwarded call and records its rejection.
   *
   * @typeParam Result - Result produced by the forwarded call.
   * @param llmEngineCall - Deferred call to the borrowed engine.
   * @returns The forwarded call's result.
   * @throws The forwarded call's original failure.
   */
  async #handleLlmEngineCall<Result>(
    llmEngineCall: () => Promise<Result>
  ): Promise<Result> {
    try {
      return await llmEngineCall()
    } catch (error) {
      this.#hasRecordedFailure = true
      throw error
    }
  }
}
