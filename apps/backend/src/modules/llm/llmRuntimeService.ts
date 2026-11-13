import type { LlmRuntimeConnectionStatus } from "@lys/protocol"
import FailureRecordingLlmEngine from "./failureRecordingLlmEngine"
import FailureRecordingLlmModelInstanceController from "./failureRecordingLlmModelInstanceController"
import type { AcquiredLlmRuntime, LlmRuntime } from "./llmRuntime"
import LlmRuntimeCallRecord from "./llmRuntimeCallRecord"
import type {
  LlmRuntimeConnectionObserver,
  LlmRuntimeConnector
} from "./llmRuntimeCapabilities"
import {
  isSameLlmProviderAccess,
  type LlmProviderAccess
} from "./llmProviderAccess"
import LlmRuntimeOperationQueue from "./llmRuntimeOperationQueue"
import { createLlmRuntimeUnavailableError } from "./llmRuntimeUnavailableError"
import type {
  ConnectedLlmEngine,
  LlmEngineOperation,
  LlmEngineOperationQueue
} from "./llmService"

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
   * Finds how to reach the service's provider as the person saved it.
   * Called at the start of every connection attempt; it resolves to
   * undefined while the provider is off, and a rejection means the provider
   * is on but not usable, such as a hosted provider without its key.
   */
  readonly findLlmProviderAccess: () => Promise<LlmProviderAccess | undefined>
  /**
   * Acquires a ready, provider-available runtime for one provider, with who
   * loads its models. A resolved runtime transfers to the service; a
   * rejection means no runtime was acquired.
   */
  readonly acquireLlmRuntime: (
    access: LlmProviderAccess
  ) => Promise<AcquiredLlmRuntime>
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
      /**
       * Exclusively owned runtime used by accepted model operations, with
       * who loads its models.
       */
      acquiredLlmRuntime: AcquiredLlmRuntime
      /** How the runtime's provider is reached; may hold a secret key. */
      llmProviderAccess: LlmProviderAccess
    }>
  | Readonly<{
      /** The latest attempt failed, or the held runtime stopped answering and was released. */
      status: "unreachable"
    }>
  | Readonly<{
      /** The latest attempt found the provider off, so it tried nothing. */
      status: "off"
    }>

/**
 * The service's provider as one read of the person's settings found it.
 *
 * @remarks `on`: the provider is on, with how to reach it. `off`: the person
 * turned it off. `unusable`: it is on but cannot be reached as saved, such as
 * a hosted provider without its key, or the settings could not be read.
 */
type SavedLlmProvider =
  | Readonly<{
      /** The provider is on. */
      status: "on"
      /** How to reach it; may hold a secret key. */
      llmProviderAccess: LlmProviderAccess
    }>
  | Readonly<{
      /** The provider is off. */
      status: "off"
    }>
  | Readonly<{
      /** The provider is on but cannot be reached as saved. */
      status: "unusable"
    }>

/** A connection attempt that connect calls share while it is pending. */
type LlmRuntimeConnectionAttempt =
  | Readonly<{
      /** Accepted by the queue; it has not started reading the saved provider. */
      status: "queued"
      /** Settled status shared by every call that joins the attempt. */
      settlement: Promise<LlmRuntimeConnectionStatus>
    }>
  | Readonly<{
      /** Started; it reads the saved provider, then connects to it. */
      status: "running"
      /** Settled status shared by every call that joins the attempt. */
      settlement: Promise<LlmRuntimeConnectionStatus>
      /**
       * The saved provider as the attempt read it; rejects only when the
       * failure reporter throws.
       */
      savedLlmProvider: Promise<SavedLlmProvider>
    }>

/** Connection state before an attempt settles or while a runtime is acquired. */
const CONNECTING_LLM_RUNTIME_CONNECTION_STATE = Object.freeze({
  status: "connecting"
} as const satisfies LlmRuntimeConnectionState)

/** Connection state after a failed attempt or a released runtime. */
const UNREACHABLE_LLM_RUNTIME_CONNECTION_STATE = Object.freeze({
  status: "unreachable"
} as const satisfies LlmRuntimeConnectionState)

/** Connection state after an attempt found the provider off. */
const OFF_LLM_RUNTIME_CONNECTION_STATE = Object.freeze({
  status: "off"
} as const satisfies LlmRuntimeConnectionState)

/**
 * Connection state an attempt leaves, holding no runtime, for a provider it
 * found off or unusable.
 */
const UNHELD_LLM_RUNTIME_CONNECTION_STATES = Object.freeze({
  off: OFF_LLM_RUNTIME_CONNECTION_STATE,
  unusable: UNREACHABLE_LLM_RUNTIME_CONNECTION_STATE
} satisfies Readonly<
  Record<Exclude<SavedLlmProvider["status"], "on">, LlmRuntimeConnectionState>
>)

/** Saved provider of a read that found it off. */
const OFF_SAVED_LLM_PROVIDER: SavedLlmProvider = Object.freeze({
  status: "off"
})

/** Saved provider of a read that found it on but unusable. */
const UNUSABLE_SAVED_LLM_PROVIDER: SavedLlmProvider = Object.freeze({
  status: "unusable"
})

/**
 * Owns the backend's connection to one provider's LLM runtime and serializes
 * every model operation against it.
 *
 * @remarks The backend runs one service per provider. Owns at most one
 * runtime, acquired through the supplied capability for the provider as the
 * person saved it, which each connection attempt reads again; a held runtime
 * for an address or key that is no longer saved is released before another
 * is acquired. An attempt that finds the provider off releases a held
 * runtime, tries nothing, and leaves the status `off` without reporting a
 * failure; model operations are then refused as runtime-unavailable, as for
 * every status but `connected`. Connection attempts and model
 * operations run through one owned {@link LlmRuntimeOperationQueue}, which
 * refuses work beyond its capacity with the service-busy error before
 * acceptance. A connect call shares a queued attempt, or a running attempt
 * that read the provider on with the same access as the call reads;
 * otherwise it queues an attempt of its own. Invariant: a runtime is held
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
  /**
   * Finds how to reach the saved provider at each connection attempt, or
   * nothing while it is off.
   */
  readonly #findLlmProviderAccess: () => Promise<LlmProviderAccess | undefined>

  /** Borrowed acquisition capability; each resolved runtime transfers to this service. */
  readonly #acquireLlmRuntime: (
    access: LlmProviderAccess
  ) => Promise<AcquiredLlmRuntime>

  /** Borrowed reporter for acquisition failures that became `unreachable`. */
  readonly #reportLlmRuntimeAcquisitionFailure: (failure: unknown) => void

  /** Borrowed reporter for failed probes or releases after a resolved operation. */
  readonly #reportLlmRuntimeAvailabilityCheckFailure: (failure: unknown) => void

  /** Exclusively owned queue of attempts and model operations, with its lifecycle. */
  readonly #operationQueue = new LlmRuntimeOperationQueue()

  /** Authoritative connection state and the runtime it holds while connected. */
  #connection: LlmRuntimeConnectionState =
    CONNECTING_LLM_RUNTIME_CONNECTION_STATE

  /**
   * The latest connection attempt connect calls may share, until the call
   * that queued it observes its settlement. At most one queued attempt
   * exists, and it is always the latest, so it is the next attempt to start.
   */
  #connectionAttempt: LlmRuntimeConnectionAttempt | undefined = undefined

  /**
   * Creates a ready service that holds no runtime until its first attempt.
   *
   * @param options - Borrowed acquisition and failure-reporting capabilities.
   */
  public constructor({
    findLlmProviderAccess,
    acquireLlmRuntime,
    reportLlmRuntimeAcquisitionFailure,
    reportLlmRuntimeAvailabilityCheckFailure
  }: LlmRuntimeServiceCreationOptions) {
    this.#findLlmProviderAccess = findLlmProviderAccess
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
   * How the provider of the held runtime is reached.
   *
   * @returns The access the held runtime was acquired for while the status is
   * `connected`, otherwise undefined. A synchronous in-memory read that never
   * contacts the provider or enters the queue.
   * @remarks Chat requests use it, so they reach the same provider as the
   * model operations and context measurements.
   */
  public get connectedLlmProviderAccess(): LlmProviderAccess | undefined {
    const connection = this.#connection
    return connection.status === "connected"
      ? connection.llmProviderAccess
      : undefined
  }

  /**
   * Implements {@link LlmRuntimeConnector.connectLlmRuntime} through the shared queue.
   *
   * @returns The interface-defined settled status.
   * @throws The interface-defined closed, service-busy, probe, and release failures.
   */
  public async connectLlmRuntime(): Promise<LlmRuntimeConnectionStatus> {
    const attempt = this.#connectionAttempt
    if (
      attempt?.status === "running" &&
      this.#operationQueue.status === "ready"
    ) {
      const savedLlmProvider = await findComparableSavedLlmProvider(
        this.#findLlmProviderAccess
      )
      if (
        isSameUsableSavedLlmProvider(
          savedLlmProvider,
          await attempt.savedLlmProvider
        )
      ) {
        return await attempt.settlement
      }
    }

    return await this.#handleLlmRuntimeConnectionRequest()
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
    if (
      this.#operationQueue.status === "ready" &&
      this.#connection.status !== "connected"
    ) {
      throw createLlmRuntimeUnavailableError([])
    }

    return await this.#operationQueue.handleLlmRuntimeOperationRequest(
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
    await this.#operationQueue.close(
      async () => await this.#closeHeldLlmRuntime()
    )
  }

  /**
   * Shares the queued connection attempt, or queues an attempt of its own.
   *
   * @returns The settled status of the shared or queued attempt.
   * @throws The closed and service-busy failures of the queue, which start no
   * attempt, and the attempt's probe and release failures.
   * @remarks Runs synchronously up to its wait, so calls made one after
   * another share one queued attempt. A queued attempt is not shared once
   * cleanup has begun. The call that queued the attempt stops offering it
   * when it observes the settlement, unless a later attempt replaced it.
   */
  async #handleLlmRuntimeConnectionRequest(): Promise<LlmRuntimeConnectionStatus> {
    const attempt = this.#connectionAttempt
    if (
      attempt?.status === "queued" &&
      this.#operationQueue.status === "ready"
    ) {
      return await attempt.settlement
    }

    const settlement = this.#operationQueue.handleLlmRuntimeOperationRequest(
      async () => await this.#updateLlmRuntimeConnection()
    )
    this.#connectionAttempt = Object.freeze({ status: "queued", settlement })
    try {
      return await settlement
    } finally {
      if (this.#connectionAttempt?.settlement === settlement) {
        this.#connectionAttempt = undefined
      }
    }
  }

  /**
   * Reads the saved provider, then keeps a held runtime for it that still
   * answers, or acquires a new one.
   *
   * @returns The settled status after the attempt.
   * @throws If probing or releasing the held runtime fails.
   * @remarks Runs only as queued work, so no model operation overlaps it.
   * As it starts, the queued attempt becomes running and carries the read it
   * makes. From then on, a connect call joins it only when the call reads the
   * provider on with the same access, because a provider saved since then
   * might not be the one it reads.
   * A held runtime for an access that is no longer the saved one is released
   * before the new one is acquired. When the provider is off, the held
   * runtime is released and the status becomes `off`; when it is unusable,
   * the held runtime is released and the status becomes `unreachable`.
   */
  async #updateLlmRuntimeConnection(): Promise<LlmRuntimeConnectionStatus> {
    const savedLlmProviderRead = this.#findSavedLlmProvider()
    const attempt = this.#connectionAttempt
    if (attempt?.status === "queued") {
      this.#connectionAttempt = Object.freeze({
        status: "running",
        settlement: attempt.settlement,
        savedLlmProvider: savedLlmProviderRead
      })
    }
    const savedLlmProvider = await savedLlmProviderRead
    const connection = this.#connection
    if (connection.status === "connected") {
      if (
        savedLlmProvider.status === "on" &&
        isSameLlmProviderAccess(
          connection.llmProviderAccess,
          savedLlmProvider.llmProviderAccess
        )
      ) {
        const status = await this.#updateLlmRuntimeAvailability(
          connection.acquiredLlmRuntime.llmRuntime
        )
        if (status === "connected") {
          return status
        }
      } else {
        await this.#closeLlmRuntimeConnection(
          connection.acquiredLlmRuntime.llmRuntime
        )
      }
    }

    if (savedLlmProvider.status !== "on") {
      this.#connection =
        UNHELD_LLM_RUNTIME_CONNECTION_STATES[savedLlmProvider.status]
      return this.#connection.status
    }
    return await this.#openLlmRuntimeConnection(
      savedLlmProvider.llmProviderAccess
    )
  }

  /**
   * Finds the saved provider for one connection attempt.
   *
   * @returns The provider on with how to reach it, off, or unusable after a
   * reported failure to find how to reach it.
   * @throws If the failure reporter throws.
   */
  async #findSavedLlmProvider(): Promise<SavedLlmProvider> {
    try {
      return buildSavedLlmProvider(await this.#findLlmProviderAccess())
    } catch (findingError) {
      this.#reportLlmRuntimeAcquisitionFailure(findingError)
      return UNUSABLE_SAVED_LLM_PROVIDER
    }
  }

  /**
   * Acquires a new runtime and records the outcome as the connection status.
   *
   * @param llmProviderAccess - How the provider is reached.
   * @returns `connected` after acquisition, or `unreachable` after a reported
   * acquisition failure.
   * @throws If the failure reporter throws; the status is already `unreachable`.
   */
  async #openLlmRuntimeConnection(
    llmProviderAccess: LlmProviderAccess
  ): Promise<LlmRuntimeConnectionStatus> {
    this.#connection = CONNECTING_LLM_RUNTIME_CONNECTION_STATE
    try {
      const acquiredLlmRuntime =
        await this.#acquireLlmRuntime(llmProviderAccess)
      this.#connection = Object.freeze({
        status: "connected",
        acquiredLlmRuntime,
        llmProviderAccess
      })
      return "connected"
    } catch (acquisitionError) {
      this.#connection = UNREACHABLE_LLM_RUNTIME_CONNECTION_STATE
      this.#reportLlmRuntimeAcquisitionFailure(acquisitionError)
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
      await this.#closeLlmRuntimeConnection(
        connection.acquiredLlmRuntime.llmRuntime
      )
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

    const { llmRuntime } = connection.acquiredLlmRuntime
    const llmRuntimeCallRecord = new LlmRuntimeCallRecord()
    let result: Result
    try {
      result = await operation(
        createConnectedLlmEngine(
          connection.acquiredLlmRuntime,
          llmRuntimeCallRecord
        )
      )
    } catch (operationError) {
      throw await this.#handleLlmEngineOperationFailure(
        llmRuntime,
        llmRuntimeCallRecord,
        operationError
      )
    }

    if (llmRuntimeCallRecord.hasRecordedFailure) {
      try {
        await this.#updateLlmRuntimeAvailability(llmRuntime)
      } catch (availabilityError) {
        this.#reportLlmRuntimeAvailabilityCheckFailure(availabilityError)
      }
    }
    return result
  }

  /**
   * Handles a rejected model operation: after a failed runtime call, probes the
   * runtime, releases it when it no longer answers, and selects the failure to report.
   *
   * @param llmRuntime - Runtime used by the operation.
   * @param llmRuntimeCallRecord - Record of the operation's runtime calls.
   * @param operationFailure - Original untrusted rejection.
   * @returns The original failure when no runtime call failed or the runtime
   * still answers; the runtime-unavailable error retaining it after release;
   * or an aggregate of it and a failed probe or release.
   */
  async #handleLlmEngineOperationFailure(
    llmRuntime: LlmRuntime,
    llmRuntimeCallRecord: LlmRuntimeCallRecord,
    operationFailure: unknown
  ): Promise<unknown> {
    if (!llmRuntimeCallRecord.hasRecordedFailure) {
      return operationFailure
    }

    try {
      const status = await this.#updateLlmRuntimeAvailability(llmRuntime)
      return status === "connected"
        ? operationFailure
        : createLlmRuntimeUnavailableError([operationFailure])
    } catch (availabilityError) {
      return new AggregateError(
        [operationFailure, availabilityError],
        "The LLM operation and the runtime availability check both failed.",
        { cause: availabilityError }
      )
    }
  }
}

/**
 * Builds the saved provider from what its lookup found.
 *
 * @param llmProviderAccess - How to reach the provider, or undefined while it
 * is off.
 * @returns The provider on with that access, or off.
 */
function buildSavedLlmProvider(
  llmProviderAccess: LlmProviderAccess | undefined
): SavedLlmProvider {
  return llmProviderAccess === undefined
    ? OFF_SAVED_LLM_PROVIDER
    : Object.freeze({ status: "on", llmProviderAccess })
}

/**
 * Finds the saved provider for a connect call to compare with a running
 * attempt's.
 *
 * @param findLlmProviderAccess - Saved-provider lookup the service borrows.
 * @returns The provider on with how to reach it, off, or unusable when the
 * lookup fails.
 * @remarks A failure is not reported here: the call then queues an attempt
 * of its own, which reads the saved provider again and reports a failure.
 */
async function findComparableSavedLlmProvider(
  findLlmProviderAccess: () => Promise<LlmProviderAccess | undefined>
): Promise<SavedLlmProvider> {
  try {
    return buildSavedLlmProvider(await findLlmProviderAccess())
  } catch {
    return UNUSABLE_SAVED_LLM_PROVIDER
  }
}

/**
 * Determines whether two reads of the saved provider both found it on and
 * reachable in the same way.
 *
 * @param callSavedLlmProvider - What a connect call read.
 * @param attemptSavedLlmProvider - What the running attempt read.
 * @returns Whether both found the provider on with the same access; a read
 * that found it off or unusable never matches.
 */
function isSameUsableSavedLlmProvider(
  callSavedLlmProvider: SavedLlmProvider,
  attemptSavedLlmProvider: SavedLlmProvider
): boolean {
  return (
    callSavedLlmProvider.status === "on" &&
    attemptSavedLlmProvider.status === "on" &&
    isSameLlmProviderAccess(
      callSavedLlmProvider.llmProviderAccess,
      attemptSavedLlmProvider.llmProviderAccess
    )
  )
}

/**
 * Creates the view of the held runtime that one model operation receives.
 *
 * @param acquiredLlmRuntime - Held runtime, with who loads its models.
 * @param llmRuntimeCallRecord - Record of the operation's runtime calls.
 * @returns The runtime's engine, and its model-loading capability when Lys
 * loads its models, each recording its rejected calls into the record.
 */
function createConnectedLlmEngine(
  acquiredLlmRuntime: AcquiredLlmRuntime,
  llmRuntimeCallRecord: LlmRuntimeCallRecord
): ConnectedLlmEngine {
  const llmEngine = new FailureRecordingLlmEngine(
    acquiredLlmRuntime.llmRuntime,
    llmRuntimeCallRecord
  )
  switch (acquiredLlmRuntime.modelLoading) {
    case "provider":
      return Object.freeze({ modelLoading: "provider", llmEngine })
    case "lys":
      return Object.freeze({
        modelLoading: "lys",
        llmEngine,
        llmModelInstanceController:
          new FailureRecordingLlmModelInstanceController(
            acquiredLlmRuntime.llmModelInstanceController,
            llmRuntimeCallRecord
          )
      })
  }
}
