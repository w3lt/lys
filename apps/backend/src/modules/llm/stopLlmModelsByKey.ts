import type { LoadedLlmModelInstance } from "./llmRuntimeTypes"

/** Queries the latest loaded-instance snapshot from the model runtime. */
export type ListLoadedLlmModelInstances = () => Promise<
  readonly LoadedLlmModelInstance[]
>

/** Stops one loaded model instance addressed by its runtime identifier. */
export type StopLoadedLlmModelInstance = (
  modelIdentifier: string
) => Promise<void>

/** Immutable operational detail retained when a model-stop dependency fails. */
export type LlmModelStopDiagnostic =
  | Readonly<{
      /** Inventory operation that could not establish initial runtime state. */
      operation: "list-initial-model-instances"
      /** Non-empty failure summary suitable for structured application logs. */
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

/**
 * Closed result of stopping every observed loaded instance for one model key.
 *
 * @remarks `stopped` means the reconciliation snapshot contained no matching
 * instance. `not-loaded` means the initial snapshot contained no match.
 * `runtime-unavailable` means either required snapshot could not be queried.
 * `stop-failed` means reconciliation still contained one or more matches.
 */
export type StopLlmModelsByKeyOutcome =
  | Readonly<{
      /** Reconciliation observed the requested model key fully stopped. */
      status: "stopped"
      /** Failures observed before the successful reconciled state. */
      diagnostics: readonly LlmModelStopDiagnostic[]
    }>
  | Readonly<{
      /** The initial snapshot contained no loaded instance for the key. */
      status: "not-loaded"
      /** Empty because no runtime operation failed. */
      diagnostics: readonly LlmModelStopDiagnostic[]
    }>
  | Readonly<{
      /** A required runtime snapshot could not be queried. */
      status: "runtime-unavailable"
      /** Failures observed before runtime state became indeterminate. */
      diagnostics: readonly LlmModelStopDiagnostic[]
    }>
  | Readonly<{
      /** Reconciliation still found instances for the requested key. */
      status: "stop-failed"
      /** Runtime identifiers still present in the reconciliation snapshot. */
      remainingModelIdentifiers: readonly string[]
      /** Stop-command failures observed before reconciliation. */
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

/** Closed result of querying and selecting loaded instances for one model key. */
type LlmModelInstanceListOutcome =
  | Readonly<{
      /** The runtime inventory was queried successfully. */
      status: "listed"
      /** Newly owned matching instances ordered by runtime identifier. */
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
 * Stops every loaded runtime instance matching one canonical model key.
 *
 * @param modelKey - Canonical model key whose loaded instances should stop.
 * @param listLoadedLlmModelInstances - Runtime query returning an immutable snapshot of loaded instances.
 * @param stopLoadedLlmModelInstance - Command that stops one instance by its runtime identifier.
 * @returns A promise resolving to the reconciled, immutable stop outcome after all initially matching instances are attempted.
 * @remarks Stop attempts run sequentially in ascending runtime-identifier
 * order and continue after individual failures. The result describes the final
 * observable reconciliation snapshot, not a durable guarantee against later
 * loads by another runtime client. Unloading is completion-only by product
 * design. The calling application service owns and awaits the inventory, stop,
 * and reconciliation work even after the requesting client disconnects.
 */
export async function stopLlmModelsByKey(
  modelKey: string,
  listLoadedLlmModelInstances: ListLoadedLlmModelInstances,
  stopLoadedLlmModelInstance: StopLoadedLlmModelInstance
): Promise<StopLlmModelsByKeyOutcome> {
  const initialListOutcome = await listLlmModelInstancesByKey(
    modelKey,
    listLoadedLlmModelInstances,
    "list-initial-model-instances"
  )

  if (initialListOutcome.status === "unavailable") {
    return Object.freeze({
      status: "runtime-unavailable",
      diagnostics: Object.freeze([initialListOutcome.diagnostic])
    })
  }

  const initialModelInstances = initialListOutcome.modelInstances

  if (initialModelInstances.length === 0) {
    return Object.freeze({
      status: "not-loaded",
      diagnostics: EMPTY_LLM_MODEL_STOP_DIAGNOSTICS
    })
  }

  const stopDiagnostics = await stopLlmModelInstances(
    initialModelInstances,
    stopLoadedLlmModelInstance
  )

  const reconciledListOutcome = await listLlmModelInstancesByKey(
    modelKey,
    listLoadedLlmModelInstances,
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

  const remainingModelInstances = reconciledListOutcome.modelInstances

  if (remainingModelInstances.length === 0) {
    return Object.freeze({
      status: "stopped",
      diagnostics: stopDiagnostics
    })
  }

  const remainingModelIdentifiers = Object.freeze(
    remainingModelInstances.map(({ modelIdentifier }) => modelIdentifier)
  )

  return Object.freeze({
    status: "stop-failed",
    remainingModelIdentifiers,
    diagnostics: stopDiagnostics
  })
}

/**
 * Lists loaded instances whose canonical key matches one requested model.
 *
 * @param modelKey - Canonical model key used for exact matching.
 * @param listLoadedLlmModelInstances - Runtime query returning the latest loaded-instance snapshot.
 * @param operation - Inventory phase to retain if the runtime query fails.
 * @returns A promise resolving to a closed, immutable inventory outcome.
 */
async function listLlmModelInstancesByKey(
  modelKey: string,
  listLoadedLlmModelInstances: ListLoadedLlmModelInstances,
  operation: LlmModelInstanceListOperation
): Promise<LlmModelInstanceListOutcome> {
  try {
    const loadedModelInstances = await listLoadedLlmModelInstances()
    const matchingModelInstances = loadedModelInstances
      .filter((modelInstance) => modelInstance.modelKey === modelKey)
      .map(({ modelKey: matchingModelKey, modelIdentifier }) =>
        Object.freeze({
          modelKey: matchingModelKey,
          modelIdentifier
        })
      )
      .toSorted(calculateLoadedLlmModelInstanceOrder)

    return Object.freeze({
      status: "listed",
      modelInstances: Object.freeze(matchingModelInstances)
    })
  } catch (failure) {
    const message = formatLlmRuntimeFailureMessage(failure)
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
 * Attempts to stop every supplied loaded model instance in collection order.
 *
 * @param modelInstances - Borrowed immutable instances selected for stopping.
 * @param stopLoadedLlmModelInstance - Command that stops one instance by its runtime identifier.
 * @returns A promise resolving to immutable diagnostics for failed commands after every instance has been attempted.
 */
async function stopLlmModelInstances(
  modelInstances: readonly LoadedLlmModelInstance[],
  stopLoadedLlmModelInstance: StopLoadedLlmModelInstance
): Promise<readonly LlmModelStopDiagnostic[]> {
  let stopDiagnostics: readonly LlmModelStopDiagnostic[] =
    EMPTY_LLM_MODEL_STOP_DIAGNOSTICS

  for (const { modelIdentifier } of modelInstances) {
    try {
      await stopLoadedLlmModelInstance(modelIdentifier)
    } catch (failure) {
      const diagnostic = Object.freeze({
        operation: "stop-model-instance",
        modelIdentifier,
        message: formatLlmRuntimeFailureMessage(failure)
      } as const satisfies LlmModelStopDiagnostic)
      stopDiagnostics = Object.freeze([...stopDiagnostics, diagnostic])
    }
  }

  return stopDiagnostics
}

/**
 * Calculates deterministic ascending order for loaded runtime identifiers.
 *
 * @param left - First loaded instance to compare.
 * @param right - Second loaded instance to compare.
 * @returns A negative value when `left` precedes `right`, a positive value when
 * `right` precedes `left`, and zero when their identifiers are equal.
 */
function calculateLoadedLlmModelInstanceOrder(
  left: LoadedLlmModelInstance,
  right: LoadedLlmModelInstance
): number {
  if (left.modelIdentifier < right.modelIdentifier) {
    return -1
  }
  if (left.modelIdentifier > right.modelIdentifier) {
    return 1
  }
  return 0
}

/**
 * Formats an opaque dependency rejection without publishing its mutable value.
 *
 * @param failure - Rejection received from an external runtime operation.
 * @returns The Error message when non-empty; otherwise a stable fallback summary.
 */
function formatLlmRuntimeFailureMessage(failure: unknown): string {
  return failure instanceof Error && failure.message.length > 0
    ? failure.message
    : UNKNOWN_LLM_RUNTIME_FAILURE_MESSAGE
}
