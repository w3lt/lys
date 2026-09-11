import type { LlmInfo } from "@lys/protocol"

/** Runtime phases exposed by synchronous lifecycle observation. */
export type LlmRuntimeLifecycleStatus =
  "ready" | "active" | "closing" | "closed"

/** Result of one admitted provider readiness query. */
export type LlmRuntimeAvailability = "available" | "unavailable"

/**
 * Validated downloaded-model metadata without application-owned loaded state.
 *
 * @remarks Snapshots and nested quantization values are newly owned and frozen.
 * Keys identify models only within the attached runtime. No SDK handle or model
 * ownership is transferred. Optional metadata is omitted when unavailable.
 */
export type DownloadedLlmModel = Readonly<Omit<LlmInfo, "loaded">>

/** Immutable observation of one loaded instance in the attached runtime. */
export type LoadedLlmModelInstance = Readonly<{
  /** Non-empty canonical model key, scoped to this runtime. */
  modelKey: string
  /** Non-empty opaque instance identifier accepted by this runtime's stop operation. */
  modelIdentifier: string
}>
