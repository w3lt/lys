import type { LlmRuntimeConnectionStatus } from "@lys/protocol"
import FailureRecordingLlmEngine from "../../modules/llm/failureRecordingLlmEngine"
import type { LlmRuntime } from "../../modules/llm/llmRuntime"
import type {
  LlmRuntimeConnectionObserver,
  LlmRuntimeConnector
} from "../../modules/llm/llmRuntimeCapabilities"
import { createLlmRuntimeUnavailableError } from "../../modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../modules/llm/llmServiceBusyError"
import type { LlmEngineOperation, LlmEngineOperationQueue } from "./llmService"

/** Receives LLM runtime failures that no caller observes, for application logging. */
export type LlmRuntimeFailureReporters = {
  /** Receives each acquisition failure after the status becomes `unreachable`. */
  readonly reportLlmRuntimeAcquisitionFailure: (failure: unknown) => void
  /**
   * Receives a failed availability probe or release that followed a resolved
   * model operation; the operation's result is still returned. After a failed
   * release the status is `unreachable`; after a failed probe it is unchanged.
   */
  readonly reportLlmRuntimeAvailabilityCheckFailure: (failure: unknown) => void
}

/** Dependencies supplied when creating the application-scoped LLM runtime service. */
export type LlmRuntimeServiceCreationOptions = LlmRuntimeFailureReporters & {
  /**
   * Acquires a ready, provider-available runtime. A resolved runtime transfers
   * to the service; a rejection means no runtime was acquired.
   */
  readonly acquireLlmRuntime: () => Promise<LlmRuntime>
}

/** Connection to the LLM runtime; a runtime is held exactly while connected. */
type LlmRuntimeConnectionState =
  | Readonly<{
      /** No attempt has settled since startup, or a new runtime is being acquired. */
      status: "connecting"
    }>
  | Readonly<{
      /** The latest acquisition or availability probe succeeded. */
      status: "connected"
      /** Exclusively owned runtime used by accepted model operations. */
      llmRuntime: LlmRuntime
    }>
  | Readonly<{
      /** The latest attempt failed, or the held runtime stopped answering and was released. */
      status: "unreachable"
    }>

/** Admission lifecycle that prevents new work after cleanup begins. */
type LlmRuntimeServiceState =
  | Readonly<{
      /** The service accepts connection attempts and model operations. */
      status: "ready"
    }>
  | Readonly<{
      /** Cleanup is waiting for accepted work or releasing the runtime. */
      status: "closing"
      /** Shared completion joined by concurrent cleanup calls. */
      completion: Promise<void>
    }>
  | Readonly<{
      /** Cleanup settled; new attempts and operations are rejected. */
      status: "closed"
      /** Settled cleanup result reused by repeated cleanup calls. */
      completion: Promise<void>
    }>

/** Ready lifecycle state established before queue admission. */
type ReadyLlmRuntimeServiceState = Extract<
  LlmRuntimeServiceState,
  { status: "ready" }
>

/**
 * Work accepted by the serialized queue.
 *
 * @typeParam Result - Result produced by the work.
 */
type LlmRuntimeServiceOperation<Result> = () => Promise<Result>

/** Private admission count and completion tail for the FIFO queue. */
type LlmRuntimeServiceQueueState = {
  /** Completion of every accepted operation, preserving progress after failure. */
  completion: Promise<void>
  /** Accepted operations that have not settled, including the active one. */
  acceptedOperationCount: number
}

/**
 * Inclusive capacity: one active operation and eight waiting operations.
 *
 * @remarks Connection attempts and model operations share this capacity. The
 * first operation reserves the active position at admission, before its
 * execution microtask starts. Excess requests are rejected without waiting.
 */
const MAX_ACCEPTED_LLM_RUNTIME_SERVICE_OPERATIONS = 9

/** Stable failure text for work requested after cleanup begins. */
const CLOSED_LLM_RUNTIME_SERVICE_MESSAGE = "The LLM runtime is closed."

/** Lifecycle state that admits work. */
const READY_LLM_RUNTIME_SERVICE_STATE = Object.freeze({
  status: "ready"
} as const satisfies LlmRuntimeServiceState)

/** Connection state before an attempt settles or while a runtime is acquired. */
const CONNECTING_LLM_RUNTIME_CONNECTION_STATE = Object.freeze({
  status: "connecting"
} as const satisfies LlmRuntimeConnectionState)

/** Connection state after a failed attempt or a released runtime. */
const UNREACHABLE_LLM_RUNTIME_CONNECTION_STATE = Object.freeze({
  status: "unreachable"
} as const satisfies LlmRuntimeConnectionState)

/**
 * Owns the backend's LLM runtime connection and serializes every model
 * operation against it.
 *
 * @remarks Owns at most one runtime, acquired through the supplied
 * capability, and the FIFO queue shared by connection attempts and model
 * operations: one active and at most eight waiting; excess requests reject
 * with the service-busy error before acceptance. Invariant: a runtime is held
 * exactly while the status is `connected`, and only queued work acquires,
 * probes, or releases it, so no attempt overlaps a model operation.
 * A model operation whose runtime call rejects is followed, before the next
 * queued work, by an availability probe; a runtime that no longer answers is
 * released and the status becomes `unreachable`. When such an operation
 * resolved, a failed probe or release is reported instead of replacing its
 * result.
 * Lifecycle: `ready -> closing -> closed`. Cleanup is terminal and idempotent:
 * it closes admission, waits for accepted work, then releases the held runtime
 * without unloading models or stopping the external engine. The connection
 * status is independent of that lifecycle and stays readable after cleanup.
 * No completion deadline is enforced; a runtime call that never settles also
 * keeps cleanup pending. Concurrency model: serialized.
 */
export default class LlmRuntimeService
  implements
    LlmRuntimeConnectionObserver,
    LlmRuntimeConnector,
    LlmEngineOperationQueue
{
  /** Borrowed acquisition capability; each resolved runtime transfers to this service. */
  readonly #acquireLlmRuntime: () => Promise<LlmRuntime>

  /** Borrowed reporter for acquisition failures that became `unreachable`. */
  readonly #reportLlmRuntimeAcquisitionFailure: (failure: unknown) => void

  /** Borrowed reporter for failed probes or releases after a resolved operation. */
  readonly #reportLlmRuntimeAvailabilityCheckFailure: (failure: unknown) => void

  /** Exclusively owned admission accounting and completion tail. */
  readonly #operationQueue: LlmRuntimeServiceQueueState = {
    completion: Promise.resolve(),
    acceptedOperationCount: 0
  }

  /** Authoritative connection state and the runtime it holds while connected. */
  #connection: LlmRuntimeConnectionState =
    CONNECTING_LLM_RUNTIME_CONNECTION_STATE

  /** Settlement joined by concurrent connect callers while an attempt is pending. */
  #pendingConnection: Promise<LlmRuntimeConnectionStatus> | undefined =
    undefined

  /** Authoritative lifecycle state controlling admission and cleanup. */
  #state: LlmRuntimeServiceState = READY_LLM_RUNTIME_SERVICE_STATE

  /**
   * Creates a ready service that holds no runtime until its first attempt.
   *
   * @param options - Borrowed acquisition and failure-reporting capabilities.
   */
  public constructor({
    acquireLlmRuntime,
    reportLlmRuntimeAcquisitionFailure,
    reportLlmRuntimeAvailabilityCheckFailure
  }: LlmRuntimeServiceCreationOptions) {
    this.#acquireLlmRuntime = acquireLlmRuntime
    this.#reportLlmRuntimeAcquisitionFailure =
      reportLlmRuntimeAcquisitionFailure
    this.#reportLlmRuntimeAvailabilityCheckFailure =
      reportLlmRuntimeAvailabilityCheckFailure
  }

  /**
   * Implements {@link LlmRuntimeConnectionObserver.llmRuntimeConnectionStatus}.
   *
   * @returns The interface-defined status, starting at `connecting`.
   */
  public get llmRuntimeConnectionStatus(): LlmRuntimeConnectionStatus {
    return this.#connection.status
  }

  /**
   * Implements {@link LlmRuntimeConnector.connectLlmRuntime} through the shared queue.
   *
   * @returns The interface-defined settled status.
   * @throws The interface-defined closed, service-busy, probe, and release failures.
   */
  public async connectLlmRuntime(): Promise<LlmRuntimeConnectionStatus> {
    this.#getReadyLlmRuntimeServiceState()
    if (this.#pendingConnection !== undefined) {
      return await this.#pendingConnection
    }

    const pendingConnection = this.#handleLlmRuntimeServiceOperationRequest(
      async () => await this.#updateLlmRuntimeConnection()
    )
    this.#pendingConnection = pendingConnection
    try {
      return await pendingConnection
    } finally {
      this.#pendingConnection = undefined
    }
  }

  /**
   * Implements {@link LlmEngineOperationQueue.handleLlmEngineOperationRequest}.
   *
   * @typeParam Result - Result produced by the operation.
   * @param operation - Interface-defined model operation.
   * @returns The interface-defined result after earlier accepted work settles.
   * @throws The interface-defined closed, runtime-unavailable, service-busy,
   * and operation failures, or an aggregate of an operation failure and a
   * failed availability probe or release.
   * @remarks After a resolved operation, a failed probe or release is reported
   * through the injected reporter instead of being thrown.
   */
  public async handleLlmEngineOperationRequest<Result>(
    operation: LlmEngineOperation<Result>
  ): Promise<Result> {
    this.#getReadyLlmRuntimeServiceState()
    if (this.#connection.status !== "connected") {
      throw createLlmRuntimeUnavailableError([])
    }

    return await this.#handleLlmRuntimeServiceOperationRequest(
      async () => await this.#handleAcceptedLlmEngineOperation(operation)
    )
  }

  /**
   * Releases the held runtime after every accepted operation settles.
   *
   * @returns A promise shared by concurrent and repeated cleanup calls.
   * @throws `The LLM runtime could not release its resources.` when release
   * fails; the service remains closed and the status is `unreachable`.
   * @remarks Cleanup rejects every later attempt and model operation with
   * `The LLM runtime is closed.`
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.#state.status !== "ready") {
      await this.#state.completion
      return
    }

    const cleanupCompletion = this.#operationQueue.completion.then(
      async () => await this.#closeHeldLlmRuntime()
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
   * Keeps a held runtime that still answers, or acquires a new one.
   *
   * @returns The settled status after the attempt.
   * @throws If probing or releasing the held runtime fails.
   * @remarks Runs only as queued work, so no model operation overlaps it.
   */
  async #updateLlmRuntimeConnection(): Promise<LlmRuntimeConnectionStatus> {
    const connection = this.#connection
    if (connection.status === "connected") {
      const status = await this.#updateLlmRuntimeAvailability(
        connection.llmRuntime
      )
      if (status === "connected") {
        return status
      }
    }

    return await this.#openLlmRuntimeConnection()
  }

  /**
   * Acquires a new runtime and records the outcome as the connection status.
   *
   * @returns `connected` after acquisition, or `unreachable` after a reported
   * acquisition failure.
   * @throws If the failure reporter throws; the status is already `unreachable`.
   */
  async #openLlmRuntimeConnection(): Promise<LlmRuntimeConnectionStatus> {
    this.#connection = CONNECTING_LLM_RUNTIME_CONNECTION_STATE
    try {
      const llmRuntime = await this.#acquireLlmRuntime()
      this.#connection = Object.freeze({ status: "connected", llmRuntime })
      return "connected"
    } catch (acquisitionFailure) {
      this.#connection = UNREACHABLE_LLM_RUNTIME_CONNECTION_STATE
      this.#reportLlmRuntimeAcquisitionFailure(acquisitionFailure)
      return "unreachable"
    }
  }

  /**
   * Probes the held runtime and releases it when it no longer answers.
   *
   * @param llmRuntime - Runtime held by the current connection.
   * @returns `connected` when it answered, otherwise `unreachable` after release.
   * @throws If the probe is refused or the release fails; after a failed
   * release the status is still `unreachable`.
   */
  async #updateLlmRuntimeAvailability(
    llmRuntime: LlmRuntime
  ): Promise<LlmRuntimeConnectionStatus> {
    const availability = await llmRuntime.getRuntimeAvailability()
    if (availability === "available") {
      return "connected"
    }

    await this.#closeLlmRuntimeConnection(llmRuntime)
    return "unreachable"
  }

  /**
   * Marks the connection unreachable, then releases the runtime it held.
   *
   * @param llmRuntime - Runtime held by the connection being closed.
   * @returns A promise resolving after the runtime is released.
   * @throws The runtime's release failure; the status stays `unreachable`.
   */
  async #closeLlmRuntimeConnection(llmRuntime: LlmRuntime): Promise<void> {
    this.#connection = UNREACHABLE_LLM_RUNTIME_CONNECTION_STATE
    await llmRuntime[Symbol.asyncDispose]()
  }

  /**
   * Releases the runtime held when cleanup runs, if any.
   *
   * @returns A promise resolving after release, or at once without a runtime.
   * @throws The runtime's release failure.
   */
  async #closeHeldLlmRuntime(): Promise<void> {
    const connection = this.#connection
    if (connection.status === "connected") {
      await this.#closeLlmRuntimeConnection(connection.llmRuntime)
    }
  }

  /**
   * Runs one accepted model operation and probes the runtime after a failed call.
   *
   * @typeParam Result - Result produced by the operation.
   * @param operation - Accepted model operation whose predecessors have settled.
   * @returns The operation result; a resolved result is kept even when the
   * probe releases the runtime, or when the probe or release fails and is
   * reported.
   * @throws The runtime-unavailable error when the connection was lost before
   * or during the operation; otherwise the operation failure, an aggregate of
   * it and a failed probe or release, or the reporter's own failure.
   */
  async #handleAcceptedLlmEngineOperation<Result>(
    operation: LlmEngineOperation<Result>
  ): Promise<Result> {
    const connection = this.#connection
    if (connection.status !== "connected") {
      throw createLlmRuntimeUnavailableError([])
    }

    const llmEngine = new FailureRecordingLlmEngine(connection.llmRuntime)
    let result: Result
    try {
      result = await operation(llmEngine)
    } catch (operationFailure) {
      throw await this.#handleLlmEngineOperationFailure(
        connection.llmRuntime,
        llmEngine,
        operationFailure
      )
    }

    if (llmEngine.hasRecordedFailure) {
      try {
        await this.#updateLlmRuntimeAvailability(connection.llmRuntime)
      } catch (availabilityFailure) {
        this.#reportLlmRuntimeAvailabilityCheckFailure(availabilityFailure)
      }
    }
    return result
  }

  /**
   * Handles a rejected model operation: after a failed runtime call, probes the
   * runtime, releases it when it no longer answers, and selects the failure to report.
   *
   * @param llmRuntime - Runtime used by the operation.
   * @param llmEngine - Engine view that recorded the operation's runtime calls.
   * @param operationFailure - Original untrusted rejection.
   * @returns The original failure when no runtime call failed or the runtime
   * still answers; the runtime-unavailable error retaining it after release;
   * or an aggregate of it and a failed probe or release.
   */
  async #handleLlmEngineOperationFailure(
    llmRuntime: LlmRuntime,
    llmEngine: FailureRecordingLlmEngine,
    operationFailure: unknown
  ): Promise<unknown> {
    if (!llmEngine.hasRecordedFailure) {
      return operationFailure
    }

    try {
      const status = await this.#updateLlmRuntimeAvailability(llmRuntime)
      return status === "connected"
        ? operationFailure
        : createLlmRuntimeUnavailableError([operationFailure])
    } catch (availabilityFailure) {
      return new AggregateError(
        [operationFailure, availabilityFailure],
        "The LLM operation and the runtime availability check both failed.",
        { cause: availabilityFailure }
      )
    }
  }

  /**
   * Adds one operation to the serialized queue.
   *
   * @typeParam Result - Result produced by the operation.
   * @param operation - Deferred work that may access the held runtime.
   * @returns The operation result after earlier accepted work settles.
   * @throws A service-busy error when capacity is exhausted, or the
   * operation's failure.
   * @remarks Admission reserves capacity synchronously. Completion releases it
   * on success or failure before the caller observes the outcome. Callers check
   * the lifecycle state first.
   */
  #handleLlmRuntimeServiceOperationRequest<Result>(
    operation: LlmRuntimeServiceOperation<Result>
  ): Promise<Result> {
    if (
      this.#operationQueue.acceptedOperationCount >=
      MAX_ACCEPTED_LLM_RUNTIME_SERVICE_OPERATIONS
    ) {
      return Promise.reject(createLlmServiceBusyError())
    }

    this.#operationQueue.acceptedOperationCount += 1
    const operationResult = this.#operationQueue.completion.then(
      async () =>
        await this.#handleAcceptedLlmRuntimeServiceOperation(operation)
    )
    this.#operationQueue.completion = operationResult.then(
      () => undefined,
      () => undefined
    )
    return operationResult
  }

  /**
   * Gets the ready lifecycle state or rejects work after cleanup begins.
   *
   * @returns The current ready state authorizing admission.
   * @throws The canonical closed failure after cleanup begins.
   */
  #getReadyLlmRuntimeServiceState(): ReadyLlmRuntimeServiceState {
    if (this.#state.status !== "ready") {
      throw new Error(CLOSED_LLM_RUNTIME_SERVICE_MESSAGE)
    }

    return this.#state
  }

  /**
   * Completes one accepted operation and releases its reserved capacity.
   *
   * @typeParam Result - Result produced by the operation.
   * @param operation - Accepted work whose predecessors have settled.
   * @returns The operation result after its capacity is released.
   * @throws The operation failure after its capacity is released.
   */
  async #handleAcceptedLlmRuntimeServiceOperation<Result>(
    operation: LlmRuntimeServiceOperation<Result>
  ): Promise<Result> {
    try {
      return await operation()
    } finally {
      this.#operationQueue.acceptedOperationCount -= 1
    }
  }
}
