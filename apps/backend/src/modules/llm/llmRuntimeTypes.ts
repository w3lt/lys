import type { LlmInfo } from "@lys/protocol"

/** Result of one admitted provider readiness query. */
export type LlmRuntimeAvailability = "available" | "unavailable"

/**
 * Validated downloaded-model metadata without application-owned loaded state.
 *
 * @remarks Snapshots and nested quantization values are newly owned and frozen.
 * Keys identify models only within the attached runtime. No SDK handle or model
 * ownership is transferred. Optional metadata is omitted when unavailable. The
 * loaded state and the loaded context length belong to the loaded instances,
 * not to the download.
 */
export type DownloadedLlmModel = Readonly<
  Omit<LlmInfo, "loaded" | "loadedContextLength">
>

/** Immutable observation of one loaded instance in the attached runtime. */
export type LoadedLlmModelInstance = Readonly<{
  /** Non-empty canonical model key, scoped to this runtime. */
  modelKey: string
  /**
   * Non-empty opaque instance identifier, which the runtime's stop operation
   * accepts when the runtime offers one.
   */
  modelIdentifier: string
  /**
   * Context length the instance is served with, in tokens, when the listing
   * reports it, as for a provider that decides which models are in memory;
   * absent when only measuring the instance finds it.
   */
  contextLength?: number
}>

/**
 * Measure of texts against one loaded model, by that model's own tokenizer.
 *
 * @remarks Counts are tokens of each text on its own, without the chat
 * template the engine wraps a request in.
 */
export type LlmContextMeasurement = Readonly<{
  /**
   * Context length the model is loaded with, in tokens; a positive integer.
   * When several instances of the model are loaded, the smallest of their
   * context lengths.
   */
  contextLength: number
  /** Token count of each measured text, in text order; whole numbers ≥ 0. */
  textTokenCounts: readonly number[]
}>
