import type { LoadedLlmModelInstance } from "./llmRuntimeTypes"
import { findLoadedLysLlmInstanceIdentifiers } from "./lysLlmInstanceIdentifiers"
import type { LysLlmInstanceStore } from "./lysLlmInstanceStore"

/** Queries the latest loaded-instance snapshot from the model runtime. */
export type ListLoadedLlmModelInstances = () => Promise<
  readonly LoadedLlmModelInstance[]
>

/** Stops one loaded model instance addressed by its runtime identifier. */
export type StopLoadedLlmModelInstance = (
  modelIdentifier: string
) => Promise<void>

/** Engine operations a stop uses, called one at a time. */
export type LlmModelInstanceStopOperations = Readonly<{
  /** Inventory query, run before and after the stops. */
  listLoadedLlmModelInstances: ListLoadedLlmModelInstances
  /** Stop command for one instance. */
  stopLoadedLlmModelInstance: StopLoadedLlmModelInstance
}>

/** Immutable operational detail retained when a model-stop dependency fails. */
export type LlmModelStopDiagnostic =
  | Readonly<{
      /** Inventory operation that could not establish initial runtime state. */
      operation: "list-initial-model-instances"
      /** Non-empty failure summary suitable for structured application logs. */
      message: string
    }>
  | Readonly<{
      /** The record of the instances Lys loaded could not be read. */
      operation: "read-lys-instance-identifiers"
      /** Non-empty reason the record gave, suitable for logs. */
      message: string
    }>
  | Readonly<{
      /** Stop command that failed before the runtime was reconciled. */
      operation: "stop-model-instance"
      /** Runtime identifier supplied to the failed stop command. */
      modelIdentifier: string
      /** Non-empty failure summary suitable for structured application logs. */
      message: string
    }>
  | Readonly<{
      /** Inventory operation that could not establish reconciled runtime state. */
      operation: "list-reconciled-model-instances"
      /** Non-empty failure summary suitable for structured application logs. */
      message: string
    }>
  | Readonly<{
      /** The record without the stopped instances could not be saved. */
      operation: "save-lys-instance-identifiers"
      /** Non-empty failure summary suitable for structured application logs. */
      message: string
    }>

/**
 * Closed result of stopping the instances of one model key that Lys loaded.
 *
 * @remarks An instance counts as Lys's when its identifier is on the record
 * of the instances Lys loaded. `stopped` means the reconciliation snapshot
 * holds none of the stopped instances. `not-loaded` means the initial
 * snapshot held no instance of the key that Lys loaded, including when the
 * record cannot be read. `runtime-unavailable` means either required
 * snapshot could not be queried. `stop-failed` means reconciliation still
 * held one or more of them. Instances another program loaded are never
 * stopped and never counted.
 */
export type StopLysLlmModelInstancesOutcome =
  | Readonly<{
      /** Reconciliation observed every instance stopped gone. */
      status: "stopped"
      /** Failures observed before the successful reconciled state, and a failed save. */
      diagnostics: readonly LlmModelStopDiagnostic[]
    }>
  | Readonly<{
      /** The initial snapshot held no instance of the key that Lys loaded. */
      status: "not-loaded"
      /** Empty, or the failed read of the record. */
      diagnostics: readonly LlmModelStopDiagnostic[]
    }>
  | Readonly<{
      /** A required runtime snapshot could not be queried. */
      status: "runtime-unavailable"
      /** Failures observed before runtime state became indeterminate. */
      diagnostics: readonly LlmModelStopDiagnostic[]
    }>
  | Readonly<{
      /** Reconciliation still found instances that were stopped. */
      status: "stop-failed"
      /** Their runtime identifiers, in ascending order. */
      remainingModelIdentifiers: readonly string[]
      /** Stop-command failures observed before reconciliation, and a failed save. */
      diagnostics: readonly LlmModelStopDiagnostic[]
    }>

/** Inventory phase represented by a loaded-model list operation. */
type LlmModelInstanceListOperation =
  "list-initial-model-instances" | "list-reconciled-model-instances"

/** Diagnostic emitted only by a loaded-model inventory operation. */
type LlmModelInstanceListDiagnostic = Extract<
  LlmModelStopDiagnostic,
  { operation: LlmModelInstanceListOperation }
>

/** Closed result of querying the loaded instances. */
type LlmModelInstanceListOutcome =
  | Readonly<{
      /** The runtime inventory was queried successfully. */
      status: "listed"
      /** The engine's snapshot. */
      modelInstances: readonly LoadedLlmModelInstance[]
    }>
  | Readonly<{
      /** The runtime inventory could not be queried. */
      status: "unavailable"
      /** Immutable failure detail for the requested inventory phase. */
      diagnostic: LlmModelInstanceListDiagnostic
    }>

/** Fallback summary for a non-Error rejection from a runtime dependency. */
const UNKNOWN_LLM_RUNTIME_FAILURE_MESSAGE = "Unknown LLM runtime failure."

/** Immutable empty diagnostic collection shared by failure-free outcomes. */
const EMPTY_LLM_MODEL_STOP_DIAGNOSTICS = Object.freeze([])

/**
 * Stops the loaded instances of one canonical model key whose identifiers
 * are on the record of the instances Lys loaded, then saves the record
 * without the instances gone.
 *
 * @param modelKey - Canonical model key whose instances Lys loaded should stop.
 * @param llmEngine - Engine inventory query and stop command.
 * @param lysLlmInstanceStore - Record of the instances Lys loaded.
 * @returns A promise resolving to the reconciled, immutable stop outcome
 * after every selected instance was attempted.
 * @remarks Stops run one after another in ascending identifier order,
 * because the runtime refuses an operation that overlaps another; a failed
 * stop does not end the others. Once reconciliation succeeds, the record is
 * saved with only the saved identifiers the reconciliation snapshot still
 * lists; a record that cannot be read is never saved over. The result
 * describes the final observable reconciliation snapshot, not a durable
 * guarantee against later loads by another runtime client. Unloading is
 * completion-only by product design. The calling application service owns
 * and awaits the inventory, stop, reconciliation, and save work even after
 * the requesting client disconnects.
 */
export async function stopLysLlmModelInstances(
  modelKey: string,
  llmEngine: LlmModelInstanceStopOperations,
  lysLlmInstanceStore: LysLlmInstanceStore
): Promise<StopLysLlmModelInstancesOutcome> {
  const initialListOutcome = await listLlmModelInstances(
    llmEngine,
    "list-initial-model-instances"
  )

  if (initialListOutcome.status === "unavailable") {
    return Object.freeze({
      status: "runtime-unavailable",
      diagnostics: Object.freeze([initialListOutcome.diagnostic])
    })
  }

  const savedRecord = await lysLlmInstanceStore.readLysLlmInstanceIdentifiers()

  if (savedRecord.status === "unreadable") {
    return Object.freeze({
      status: "not-loaded",
      diagnostics: Object.freeze([
        Object.freeze({
          operation: "read-lys-instance-identifiers",
          message: savedRecord.message
        } as const satisfies LlmModelStopDiagnostic)
      ])
    })
  }

  const targetIdentifiers = listLysModelInstanceIdentifiers(
    modelKey,
    initialListOutcome.modelInstances,
    savedRecord.instanceIdentifiers
  )

  if (targetIdentifiers.length === 0) {
    return Object.freeze({
      status: "not-loaded",
      diagnostics: EMPTY_LLM_MODEL_STOP_DIAGNOSTICS
    })
  }

  const stopDiagnostics = await stopLlmModelInstances(
    targetIdentifiers,
    llmEngine
  )

  const reconciledListOutcome = await listLlmModelInstances(
    llmEngine,
    "list-reconciled-model-instances"
  )

  if (reconciledListOutcome.status === "unavailable") {
    return Object.freeze({
      status: "runtime-unavailable",
      diagnostics: Object.freeze([
        ...stopDiagnostics,
        reconciledListOutcome.diagnostic
      ])
    })
  }

  const remainingIdentifiers = findLoadedLysLlmInstanceIdentifiers(
    new Set(targetIdentifiers),
    reconciledListOutcome.modelInstances
  )
  const saveDiagnostic = await saveLoadedLysLlmInstanceIdentifiers(
    savedRecord.instanceIdentifiers,
    reconciledListOutcome.modelInstances,
    lysLlmInstanceStore
  )
  const diagnostics =
    saveDiagnostic === undefined
      ? stopDiagnostics
      : Object.freeze([...stopDiagnostics, saveDiagnostic])

  if (remainingIdentifiers.size === 0) {
    return Object.freeze({ status: "stopped", diagnostics })
  }

  return Object.freeze({
    status: "stop-failed",
    remainingModelIdentifiers: Object.freeze(
      [...remainingIdentifiers].toSorted()
    ),
    diagnostics
  })
}

/**
 * Lists the identifiers of the loaded instances of one key that are on the
 * record.
 *
 * @param modelKey - Canonical model key used for exact matching.
 * @param modelInstances - Snapshot of the loaded instances.
 * @param savedIdentifiers - Identifiers on the record.
 * @returns A newly owned array of the matching identifiers, ascending.
 */
function listLysModelInstanceIdentifiers(
  modelKey: string,
  modelInstances: readonly LoadedLlmModelInstance[],
  savedIdentifiers: ReadonlySet<string>
): readonly string[] {
  return modelInstances
    .filter(
      (modelInstance) =>
        modelInstance.modelKey === modelKey &&
        savedIdentifiers.has(modelInstance.modelIdentifier)
    )
    .map(({ modelIdentifier }) => modelIdentifier)
    .toSorted()
}

/**
 * Queries the loaded instances, keeping a failure as a diagnostic.
 *
 * @param llmEngine - Engine whose inventory query runs.
 * @param operation - Inventory phase to retain if the runtime query fails.
 * @returns A promise resolving to a closed, immutable inventory outcome.
 */
async function listLlmModelInstances(
  llmEngine: LlmModelInstanceStopOperations,
  operation: LlmModelInstanceListOperation
): Promise<LlmModelInstanceListOutcome> {
  try {
    const modelInstances = await llmEngine.listLoadedLlmModelInstances()
    return Object.freeze({ status: "listed", modelInstances })
  } catch (error) {
    const message = formatLlmRuntimeFailureMessage(error)
    const diagnostic =
      operation === "list-initial-model-instances"
        ? Object.freeze({
            operation: "list-initial-model-instances",
            message
          } as const satisfies LlmModelInstanceListDiagnostic)
        : Object.freeze({
            operation: "list-reconciled-model-instances",
            message
          } as const satisfies LlmModelInstanceListDiagnostic)

    return Object.freeze({
      status: "unavailable",
      diagnostic
    })
  }
}

/**
 * Attempts to stop every selected instance, one after another.
 *
 * @param modelIdentifiers - Identifiers of the instances to stop, in order.
 * @param llmEngine - Engine whose stop command runs.
 * @returns A promise resolving after the last command settles, to immutable
 * diagnostics for the failed commands in collection order.
 * @remarks Each command starts after the previous one settles, because the
 * runtime refuses an operation that overlaps another; a failed command does
 * not end the others.
 */
async function stopLlmModelInstances(
  modelIdentifiers: readonly string[],
  llmEngine: LlmModelInstanceStopOperations
): Promise<readonly LlmModelStopDiagnostic[]> {
  const stopDiagnostics: LlmModelStopDiagnostic[] = []
  for (const modelIdentifier of modelIdentifiers) {
    const stopDiagnostic = await stopLlmModelInstance(
      modelIdentifier,
      llmEngine
    )
    if (stopDiagnostic !== undefined) stopDiagnostics.push(stopDiagnostic)
  }

  return stopDiagnostics.length === 0
    ? EMPTY_LLM_MODEL_STOP_DIAGNOSTICS
    : Object.freeze(stopDiagnostics)
}

/**
 * Attempts one stop command and keeps its failure as a diagnostic.
 *
 * @param modelIdentifier - Runtime identifier of the instance to stop.
 * @param llmEngine - Engine whose stop command runs.
 * @returns A promise resolving after the command settles: undefined when it
 * succeeded, otherwise an immutable diagnostic for its failure.
 */
async function stopLlmModelInstance(
  modelIdentifier: string,
  llmEngine: LlmModelInstanceStopOperations
): Promise<LlmModelStopDiagnostic | undefined> {
  try {
    await llmEngine.stopLoadedLlmModelInstance(modelIdentifier)
    return undefined
  } catch (error) {
    return Object.freeze({
      operation: "stop-model-instance",
      modelIdentifier,
      message: formatLlmRuntimeFailureMessage(error)
    } as const satisfies LlmModelStopDiagnostic)
  }
}

/**
 * Saves the record with only the saved identifiers still loaded.
 *
 * @param savedIdentifiers - Identifiers on the record before the stops.
 * @param modelInstances - Reconciliation snapshot.
 * @param lysLlmInstanceStore - Record of the instances Lys loaded.
 * @returns A promise resolving to undefined once saved, or to a diagnostic
 * for a failed save, which leaves the identifiers of instances gone on the
 * record until a later load or unload drops them.
 */
async function saveLoadedLysLlmInstanceIdentifiers(
  savedIdentifiers: ReadonlySet<string>,
  modelInstances: readonly LoadedLlmModelInstance[],
  lysLlmInstanceStore: LysLlmInstanceStore
): Promise<LlmModelStopDiagnostic | undefined> {
  try {
    await lysLlmInstanceStore.saveLysLlmInstanceIdentifiers(
      findLoadedLysLlmInstanceIdentifiers(savedIdentifiers, modelInstances)
    )
    return undefined
  } catch (error) {
    return Object.freeze({
      operation: "save-lys-instance-identifiers",
      message: formatLlmRuntimeFailureMessage(error)
    } as const satisfies LlmModelStopDiagnostic)
  }
}

/**
 * Formats an opaque dependency rejection without publishing its mutable value.
 *
 * @param failure - Rejection received from an external runtime operation or
 * the record.
 * @returns The Error message when non-empty; otherwise a stable fallback summary.
 */
function formatLlmRuntimeFailureMessage(failure: unknown): string {
  return failure instanceof Error && failure.message.length > 0
    ? failure.message
    : UNKNOWN_LLM_RUNTIME_FAILURE_MESSAGE
}
