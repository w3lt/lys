import type { LlmEngine } from "./llmEngine"
import type LlmRuntimeCallRecord from "./llmRuntimeCallRecord"
import type {
  DownloadedLlmModel,
  LlmContextMeasurement,
  LoadedLlmModelInstance
} from "./llmRuntimeTypes"

/**
 * Forwards one model operation's engine calls while recording whether any
 * rejected.
 *
 * @remarks Borrows the engine, which remains owned by the runtime service,
 * and the call record of the operation. Results and rejections are forwarded
 * unchanged; a synchronous throw from the engine is forwarded as a
 * rejection. Concurrency model: single-owner; the runtime service creates
 * one instance per accepted operation and discards it when that operation
 * settles.
 */
export default class FailureRecordingLlmEngine implements LlmEngine {
  /** Borrowed engine that performs every forwarded call. */
  readonly #llmEngine: LlmEngine

  /** Borrowed record of the operation's runtime calls. */
  readonly #llmRuntimeCallRecord: LlmRuntimeCallRecord

  /**
   * Creates a forwarder that records into one operation's call record.
   *
   * @param llmEngine - Borrowed engine whose calls are forwarded.
   * @param llmRuntimeCallRecord - Borrowed record of the operation's calls.
   */
  public constructor(
    llmEngine: LlmEngine,
    llmRuntimeCallRecord: LlmRuntimeCallRecord
  ) {
    this.#llmEngine = llmEngine
    this.#llmRuntimeCallRecord = llmRuntimeCallRecord
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
    return await this.#llmRuntimeCallRecord.handleLlmRuntimeCall(
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
    return await this.#llmRuntimeCallRecord.handleLlmRuntimeCall(
      async () => await this.#llmEngine.listLoadedLlmModelInstances()
    )
  }

  /**
   * Implements {@link LlmEngine.findLlmContextMeasurement} by forwarding.
   *
   * @param model - Interface-defined model selection.
   * @param texts - Interface-defined texts to count, forwarded unchanged.
   * @returns The interface-defined measurement from the borrowed engine.
   * @throws The borrowed engine's failure, after recording it.
   */
  public async findLlmContextMeasurement(
    model: string,
    texts: readonly string[]
  ): Promise<LlmContextMeasurement | undefined> {
    return await this.#llmRuntimeCallRecord.handleLlmRuntimeCall(
      async () => await this.#llmEngine.findLlmContextMeasurement(model, texts)
    )
  }
}
