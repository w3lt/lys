/** Private native-error cause identifying a refused load or unload. */
const LLM_PROVIDER_LOADS_MODELS_CAUSE = Symbol("llm-provider-loads-models")

/**
 * Creates the failure for a load or unload refused because the connected
 * provider loads a model when a request names it.
 *
 * @returns A new native error recognized by {@link isLlmProviderLoadsModelsError}.
 * @remarks This error guarantees the refused operation made no runtime call.
 * Its cause identifies the refusal independently of display text.
 */
export function createLlmProviderLoadsModelsError(): Error {
  return new Error("The connected model provider loads its own models.", {
    cause: LLM_PROVIDER_LOADS_MODELS_CAUSE
  })
}

/**
 * Determines whether a caught value is a recognized refusal of a load or
 * unload by a provider that loads its own models.
 *
 * @param failure - Untrusted rejection from an application model operation.
 * @returns Whether the native error carries the private refusal cause.
 * @remarks Accessors are not invoked. Uninspectable values are unrecognized so
 * the caller can propagate the original failure through its normal boundary.
 */
export function isLlmProviderLoadsModelsError(failure: unknown): boolean {
  try {
    return (
      failure instanceof Error &&
      Object.getOwnPropertyDescriptor(failure, "cause")?.value ===
        LLM_PROVIDER_LOADS_MODELS_CAUSE
    )
  } catch {
    return false
  }
}
