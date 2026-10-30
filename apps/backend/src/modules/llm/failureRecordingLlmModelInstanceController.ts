import type { ModelLoadConfiguration } from "@lys/share"
import type { LlmModelInstanceController } from "./llmModelInstanceController"
import type LlmRuntimeCallRecord from "./llmRuntimeCallRecord"
import type { LoadedLlmModelInstance } from "./llmRuntimeTypes"

/**
 * Forwards one model operation's load and stop calls while recording whether
 * any rejected.
 *
 * @remarks Borrows the controller, which remains owned by the runtime
 * service, and the call record of the operation. Results and rejections are
 * forwarded unchanged; a synchronous throw from the controller is forwarded
 * as a rejection. Concurrency model: single-owner; the runtime service
 * creates one instance per accepted operation and discards it when that
 * operation settles.
 */
export default class FailureRecordingLlmModelInstanceController implements LlmModelInstanceController {
  /** Borrowed controller that performs every forwarded call. */
  readonly #llmModelInstanceController: LlmModelInstanceController

  /** Borrowed record of the operation's runtime calls. */
  readonly #llmRuntimeCallRecord: LlmRuntimeCallRecord

  /**
   * Creates a forwarder that records into one operation's call record.
   *
   * @param llmModelInstanceController - Borrowed controller whose calls are
   * forwarded.
   * @param llmRuntimeCallRecord - Borrowed record of the operation's calls.
   */
  public constructor(
    llmModelInstanceController: LlmModelInstanceController,
    llmRuntimeCallRecord: LlmRuntimeCallRecord
  ) {
    this.#llmModelInstanceController = llmModelInstanceController
    this.#llmRuntimeCallRecord = llmRuntimeCallRecord
  }

  /**
   * Implements {@link LlmModelInstanceController.loadLlmModel} by forwarding.
   *
   * @param modelKeyOrAlias - Interface-defined engine model selection.
   * @param loadConfiguration - Interface-defined load settings, forwarded unchanged.
   * @returns The interface-defined identity from the borrowed controller.
   * @throws The borrowed controller's failure, after recording it.
   */
  public async loadLlmModel(
    modelKeyOrAlias: string,
    loadConfiguration: ModelLoadConfiguration
  ): Promise<LoadedLlmModelInstance> {
    return await this.#llmRuntimeCallRecord.handleLlmRuntimeCall(
      async () =>
        await this.#llmModelInstanceController.loadLlmModel(
          modelKeyOrAlias,
          loadConfiguration
        )
    )
  }

  /**
   * Implements {@link LlmModelInstanceController.stopLoadedLlmModelInstance}
   * by forwarding.
   *
   * @param modelIdentifier - Interface-defined loaded-instance identifier.
   * @returns A promise resolving after the borrowed controller acknowledges the stop.
   * @throws The borrowed controller's failure, after recording it.
   */
  public async stopLoadedLlmModelInstance(
    modelIdentifier: string
  ): Promise<void> {
    await this.#llmRuntimeCallRecord.handleLlmRuntimeCall(
      async () =>
        await this.#llmModelInstanceController.stopLoadedLlmModelInstance(
          modelIdentifier
        )
    )
  }
}
