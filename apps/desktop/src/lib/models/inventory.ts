/**
 * Locally available model weights shown by the composer and settings.
 *
 * @remarks This inventory is a fixed placeholder. The backend exposes the real
 * list at `GET /v1/llm/list`, which returns richer metadata per model; until a
 * renderer adapter reads that endpoint, both views render from this constant so
 * their layout and selection behavior are settled. Replacing it means swapping
 * the source, not reshaping the views.
 */

/** One set of model weights available on this machine. */
export type LocalModelDescriptor = {
  /** Identifier used to select and load the weights. */
  readonly modelKey: string
  /** Parameter count, quantization, and on-disk size, as one line. */
  readonly detail: string
  /** On-disk size shown when the weights are neither selected nor resident. */
  readonly sizeLabel: string
}

/** Placeholder inventory standing in for the backend model list. */
export const LOCAL_MODEL_INVENTORY: readonly LocalModelDescriptor[] = [
  {
    modelKey: "qwen3-8b-instruct",
    detail: "8.2B · Q4_K_M · 4.9 GB",
    sizeLabel: "4.9 GB"
  },
  {
    modelKey: "mistral-nemo-12b",
    detail: "12.2B · Q4_K_M · 7.1 GB",
    sizeLabel: "7.1 GB"
  },
  {
    modelKey: "phi-4-mini",
    detail: "3.8B · Q6_K · 2.4 GB",
    sizeLabel: "2.4 GB"
  }
]
