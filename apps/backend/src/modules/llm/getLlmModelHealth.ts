import {
  llmTestModelApiResponseSchema,
  type LlmTestModelApiResponse
} from "@lys/protocol"
import {
  createLlmModelHealthDiagnostic,
  type LlmModelHealthDiagnostic
} from "./llmModelHealthDiagnostic"
import type { ListLoadedLlmModelInstances } from "./stopLlmModelsByKey"
import type { LoadedLlmModelInstance } from "./llmRuntimeTypes"

export type { LlmModelHealthDiagnostic } from "./llmModelHealthDiagnostic"

/**
 * Immutable health observation and internal diagnostics for one canonical model key.
 *
 * @remarks Diagnostics are excluded from the public HTTP response. A ready
 * health value means only that a fresh valid inventory contained the model key.
 * Consumers must synchronously report every diagnostic before completing their
 * boundary response.
 */
export type LlmModelHealthOutcome = Readonly<{
  /** Validated public loaded-state observation. */
  health: LlmTestModelApiResponse
  /** Required internal failure reports, empty after a successful query. */
  diagnostics: readonly LlmModelHealthDiagnostic[]
}>

/** Result of one loaded-inventory query before health response construction. */
type LoadedLlmModelInventoryOutcome =
  | Readonly<{
      /** The runtime returned a valid loaded-instance snapshot. */
      status: "listed"
      /** Borrowed immutable instances returned by the runtime query. */
      modelInstances: readonly LoadedLlmModelInstance[]
    }>
  | Readonly<{
      /** The runtime inventory query failed. */
      status: "unavailable"
      /** Immutable failure detail retained for application logging. */
      diagnostic: LlmModelHealthDiagnostic
    }>

/** Immutable empty diagnostic collection shared by successful inventory observations. */
const EMPTY_LLM_MODEL_HEALTH_DIAGNOSTICS = Object.freeze([])

/**
 * Observes whether a fresh loaded-model inventory contains one canonical key.
 *
 * @param modelKey - Canonical model key compared exactly with loaded identities.
 * @param listLoadedLlmModelInstances - Runtime query returning a validated immutable snapshot.
 * @param readMonotonicTimeMs - Monotonic millisecond clock read around the admitted query.
 * @returns A promise resolving to a validated immutable health outcome.
 * @throws If response validation, the monotonic clock, or synchronous query
 * invocation fails; inventory-promise rejections become `runtime-unavailable`.
 * @remarks The operation performs one inventory query and no model mutation or
 * generation. Its latency covers only work inside this function; callers must
 * invoke it after queue admission to exclude queue waiting.
 */
export async function getLlmModelHealth(
  modelKey: string,
  listLoadedLlmModelInstances: ListLoadedLlmModelInstances,
  readMonotonicTimeMs: () => number
): Promise<LlmModelHealthOutcome> {
  const queryStartedAtMs = readMonotonicTimeMs()
  // Translate only inventory rejection, leaving result-construction failures observable.
  const inventoryOutcome = await listLoadedLlmModelInstances().then(
    (modelInstances): LoadedLlmModelInventoryOutcome =>
      Object.freeze({ status: "listed", modelInstances }),
    createUnavailableLlmModelInventoryOutcome
  )
  const latencyMs = Math.round(readMonotonicTimeMs() - queryStartedAtMs)

  return createLlmModelHealthOutcome(modelKey, latencyMs, inventoryOutcome)
}

/**
 * Retains one runtime rejection as an unavailable inventory result.
 *
 * @param failure - Original untrusted value rejected by the runtime query.
 * @returns An immutable unavailable-inventory result with opaque evidence.
 */
function createUnavailableLlmModelInventoryOutcome(
  failure: unknown
): LoadedLlmModelInventoryOutcome {
  const diagnostic = createLlmModelHealthDiagnostic(failure)
  return Object.freeze({ status: "unavailable", diagnostic })
}

/**
 * Constructs the validated public health value and its separate diagnostics.
 *
 * @param modelKey - Canonical model key represented by the observation.
 * @param latencyMs - Rounded monotonic query duration in milliseconds.
 * @param inventoryOutcome - Completed runtime inventory observation.
 * @returns A newly owned immutable health outcome.
 * @throws If the constructed public health value violates its protocol schema.
 */
function createLlmModelHealthOutcome(
  modelKey: string,
  latencyMs: number,
  inventoryOutcome: LoadedLlmModelInventoryOutcome
): LlmModelHealthOutcome {
  if (inventoryOutcome.status === "unavailable") {
    const health = llmTestModelApiResponseSchema.parse({
      modelId: modelKey,
      status: "not-ready",
      reason: "runtime-unavailable",
      latencyMs
    })
    return Object.freeze({
      health,
      diagnostics: Object.freeze([inventoryOutcome.diagnostic])
    })
  }

  const isLoaded = inventoryOutcome.modelInstances.some(
    (modelInstance) => modelInstance.modelKey === modelKey
  )
  const health = llmTestModelApiResponseSchema.parse(
    isLoaded
      ? { modelId: modelKey, status: "ready", latencyMs }
      : {
          modelId: modelKey,
          status: "not-ready",
          reason: "model-not-loaded",
          latencyMs
        }
  )
  return Object.freeze({
    health,
    diagnostics: EMPTY_LLM_MODEL_HEALTH_DIAGNOSTICS
  })
}
