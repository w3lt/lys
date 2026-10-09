import { llmInfoSchema, type LlmInfo } from "@lys/protocol"

/** Fields a case may vary on a downloaded model; every other field is fixed. */
export type LlmInfoVariation = Readonly<{
  /** Name LM Studio shows; defaults to the model key in title case. */
  displayName?: string
  /** Whether the model's weights are in memory; defaults to false. */
  loaded?: boolean
  /** Largest context window in tokens; defaults to 8192. */
  maxContextLength?: number
  /** Whether the model accepts images; defaults to false. */
  vision?: boolean
  /** Whether the model was trained for tool use; defaults to false. */
  trainedForToolUse?: boolean
}>

/**
 * Builds one downloaded model as the backend lists it.
 *
 * @param modelKey - Canonical inventory key; it also names the fixture file.
 * @param variation - Fields the case depends on.
 * @returns A frozen model validated by the shared list schema, so a fixture
 * can never be a shape the backend would not send.
 */
export function buildLlmInfo(
  modelKey: string,
  variation: LlmInfoVariation = {}
): LlmInfo {
  return Object.freeze(
    llmInfoSchema.parse({
      modelKey,
      format: "gguf",
      displayName: variation.displayName ?? `Model ${modelKey}`,
      path: `publisher/${modelKey}/${modelKey}.gguf`,
      sizeBytes: 4_000_000_000,
      paramsString: "7B",
      architecture: "llama",
      quantization: { name: "Q4_K_M", bits: 4 },
      vision: variation.vision ?? false,
      trainedForToolUse: variation.trainedForToolUse ?? false,
      maxContextLength: variation.maxContextLength ?? 8192,
      loaded: variation.loaded ?? false
    })
  )
}
