import { LMStudioClient } from "@lmstudio/sdk"
import type { LlmRuntime } from "../llmRuntime"
import type {
  DownloadedLlmModel,
  LlmRuntimeAvailability,
  LlmRuntimeLifecycleStatus,
  LoadedLlmModelInstance
} from "../llmRuntimeTypes"
import {
  createDownloadedLlmModelSnapshot,
  createLoadedLlmModelInstanceSnapshot
} from "./lmStudioModelSnapshots"

/** Admission and cleanup state owned exclusively by one LM Studio runtime. */
type LmStudioRuntimeState =
  | Readonly<{
      /** No active operation; model work may begin. */
      status: "ready"
    }>
  | Readonly<{
      /** One accepted operation retains the SDK client until settlement. */
      status: "active"
      /** Non-rejecting settlement joined by cleanup regardless of operation outcome. */
      completion: Promise<void>
    }>
  | Readonly<{
      /** Admission is terminally closed while work and cleanup settle. */
      status: "closing"
      /** Shared cleanup outcome retained for every disposal caller. */
      completion: Promise<void>
    }>
  | Readonly<{
      /** Cleanup settled successfully or failed; model operations remain forbidden. */
      status: "closed"
      /** Settled cleanup outcome retained without retrying resource release. */
      completion: Promise<void>
    }>

/**
 * Owns one LM Studio client to implement {@link LlmRuntime} with terminal cleanup.
 *
 * @remarks Concurrency
 * model: single-owner; the owning service confines calls, and synchronous
 * admission rejects operational overlap before SDK access. State transitions are
 * `ready -> active -> ready` and `ready | active -> closing -> closed`.
 * There is no runtime waiting queue. The owned disposal stack is the client's
 * sole release registration; the client field borrows that protected resource.
 * Model operations retain the interface's application-owned completion-only
 * lifetime. Cleanup closes SDK connections without unloading engine models.
 */
export default class LmStudioRuntime implements LlmRuntime {
  /** SDK client borrowed from this runtime's exclusively owned disposal stack. */
  readonly #client: LMStudioClient

  /** Sole owner of the SDK client's required release operation. */
  readonly #clientLifetime: AsyncDisposableStack

  /** Authoritative operational admission and terminal cleanup state. */
  #state: LmStudioRuntimeState = Object.freeze({ status: "ready" })

  /**
   * Observes the current runtime admission and cleanup phase.
   *
   * @returns The authoritative phase at the instant of access.
   */
  public get lifecycleStatus(): LlmRuntimeLifecycleStatus {
    return this.#state.status
  }

  /**
   * Retains an already protected SDK client without starting external work.
   *
   * @param client - Client whose sole cleanup registration belongs to clientLifetime.
   * @param clientLifetime - Protected client lifetime transferred exclusively to this runtime.
   */
  private constructor(
    client: LMStudioClient,
    clientLifetime: AsyncDisposableStack
  ) {
    this.#client = client
    this.#clientLifetime = clientLifetime
  }

  /**
   * Acquires a ready SDK adapter for an available configured endpoint.
   *
   * @param lmsBaseUrl - WebSocket endpoint validated by the SDK before acquisition.
   * @returns A ready runtime whose cleanup ownership transfers to the caller.
   * @throws `The LLM runtime is unavailable.` with the SDK query failure as its
   * cause, or an SDK construction failure. Acquired resources are released before
   * rejection, preserving acquisition and cleanup failures if both occur.
   * @remarks Acquisition completes only after the SDK readiness query settles.
   * The SDK offers no safe deadline or cancellation for this query.
   */
  public static async create(lmsBaseUrl: string): Promise<LmStudioRuntime> {
    const clientLifetime = new AsyncDisposableStack()
    try {
      const client = clientLifetime.use(
        new LMStudioClient({ baseUrl: lmsBaseUrl })
      )
      const availabilityQuery = client.system.getLMStudioVersion()
      try {
        await availabilityQuery
      } catch (cause) {
        throw new Error("The LLM runtime is unavailable.", { cause })
      }
      return new LmStudioRuntime(client, clientLifetime)
    } catch (creationFailure) {
      try {
        await clientLifetime.disposeAsync()
      } catch (cleanupFailure) {
        throw new AggregateError(
          [creationFailure, cleanupFailure],
          "LLM runtime creation and cleanup both failed.",
          { cause: cleanupFailure }
        )
      }
      throw creationFailure
    }
  }

  /**
   * Checks whether the attached LM Studio engine answers its readiness query.
   *
   * @returns The interface-defined availability after the completion-only query settles.
   * @throws The interface-defined admission failure when the runtime is busy or closed.
   */
  public async getRuntimeAvailability(): Promise<LlmRuntimeAvailability> {
    const operation = this.#startRuntimeOperation()
    try {
      const availabilityQuery = this.#client.system.getLMStudioVersion()
      try {
        await availabilityQuery
        return "available"
      } catch {
        return "unavailable"
      }
    } finally {
      this.#handleRuntimeOperationCompletion(operation)
    }
  }

  /**
   * Implements {@link LlmRuntime.listDownloadedLlmModels} through SDK inventory.
   *
   * @returns The interface-defined immutable metadata after vendor normalization.
   * @throws The interface-defined admission, query, or metadata failure.
   */
  public async listDownloadedLlmModels(): Promise<
    readonly DownloadedLlmModel[]
  > {
    const operation = this.#startRuntimeOperation()
    try {
      const models = await this.#client.system
        .listDownloadedModels("llm")
        .catch((cause: unknown) => {
          throw new Error("The LLM runtime could not list downloaded models.", {
            cause
          })
        })
      return Object.freeze(models.map(createDownloadedLlmModelSnapshot))
    } finally {
      this.#handleRuntimeOperationCompletion(operation)
    }
  }

  /**
   * Implements {@link LlmRuntime.listLoadedLlmModelInstances} through SDK handles.
   *
   * @returns The interface-defined immutable identities after vendor normalization.
   * @throws The interface-defined admission, query, or identity failure.
   */
  public async listLoadedLlmModelInstances(): Promise<
    readonly LoadedLlmModelInstance[]
  > {
    const operation = this.#startRuntimeOperation()
    try {
      const models = await this.#client.llm
        .listLoaded()
        .catch((cause: unknown) => {
          throw new Error(
            "The LLM runtime could not list loaded model instances.",
            { cause }
          )
        })
      return Object.freeze(models.map(createLoadedLlmModelInstanceSnapshot))
    } finally {
      this.#handleRuntimeOperationCompletion(operation)
    }
  }

  /**
   * Implements {@link LlmRuntime.loadLlmModel} with a completion-only SDK load.
   *
   * @param modelKeyOrAlias - Interface-defined engine model selection.
   * @returns The interface-defined canonical identity after the SDK load completes.
   * @throws The interface-defined admission, load, or identity failure.
   */
  public async loadLlmModel(
    modelKeyOrAlias: string
  ): Promise<LoadedLlmModelInstance> {
    const operation = this.#startRuntimeOperation()
    try {
      const loadedModel = await this.#client.llm
        .load(modelKeyOrAlias)
        .catch((cause: unknown) => {
          throw new Error("The LLM runtime could not load the model.", {
            cause
          })
        })
      return createLoadedLlmModelInstanceSnapshot(loadedModel)
    } finally {
      this.#handleRuntimeOperationCompletion(operation)
    }
  }

  /**
   * Implements {@link LlmRuntime.stopLoadedLlmModelInstance} through SDK unloading.
   *
   * @param modelIdentifier - Interface-defined opaque loaded-instance identifier.
   * @returns A promise resolving after the SDK acknowledges unloading.
   * @throws The interface-defined admission or stop failure.
   */
  public async stopLoadedLlmModelInstance(
    modelIdentifier: string
  ): Promise<void> {
    const operation = this.#startRuntimeOperation()
    try {
      await this.#client.llm.unload(modelIdentifier)
    } catch (cause) {
      throw new Error("The LLM runtime could not stop the model instance.", {
        cause
      })
    } finally {
      this.#handleRuntimeOperationCompletion(operation)
    }
  }

  /**
   * Implements the {@link LlmRuntime} disposal contract for the owned SDK client.
   *
   * @returns The shared cleanup outcome after active work and SDK release settle.
   * @throws The interface-defined terminal resource-release failure.
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.#state.status === "closing" || this.#state.status === "closed") {
      return await this.#state.completion
    }
    const activeCompletion =
      this.#state.status === "active"
        ? this.#state.completion
        : Promise.resolve()
    const cleanupCompletion = activeCompletion.then(
      async () => await this.#closeRuntimeResources()
    )
    this.#state = Object.freeze({
      status: "closing",
      completion: cleanupCompletion
    })
    try {
      await cleanupCompletion
    } finally {
      this.#state = Object.freeze({
        status: "closed",
        completion: cleanupCompletion
      })
    }
  }

  /**
   * Reserves the runtime's sole operation position before any SDK effect.
   *
   * @returns Settlement authority retained by the accepted operation's finalizer.
   * @throws The interface-defined closed or active-operation failure.
   */
  #startRuntimeOperation(): PromiseWithResolvers<void> {
    if (this.#state.status === "closing" || this.#state.status === "closed") {
      throw new Error("The LLM runtime is closed.")
    }
    if (this.#state.status === "active") {
      throw new Error("The LLM runtime already has an active operation.")
    }
    const operation = Promise.withResolvers<void>()
    this.#state = Object.freeze({
      status: "active",
      completion: operation.promise
    })
    return operation
  }

  /**
   * Ends the accepted call while preserving a concurrent terminal cleanup transition.
   *
   * @param operation - Settlement authority of the currently active operation.
   */
  #handleRuntimeOperationCompletion(
    operation: PromiseWithResolvers<void>
  ): void {
    if (this.#state.status === "active") {
      this.#state = Object.freeze({ status: "ready" })
    }
    operation.resolve()
  }

  /**
   * Releases the sole SDK registration and translates failure for its cleanup owner.
   *
   * @returns A promise resolving after SDK client disposal completes.
   * @throws The interface-defined resource-release failure with the original cause.
   */
  async #closeRuntimeResources(): Promise<void> {
    try {
      await this.#clientLifetime.disposeAsync()
    } catch (cause) {
      throw new Error("The LLM runtime could not release its resources.", {
        cause
      })
    }
  }
}
