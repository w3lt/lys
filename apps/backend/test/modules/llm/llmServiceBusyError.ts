/** Private native-error cause identifying refusal before queue admission. */
const LLM_SERVICE_BUSY_CAUSE = Symbol("llm-service-busy")

/**
 * Creates a failure for a model operation refused before queue admission.
 *
 * @returns A new native error recognized by {@link isLlmServiceBusyError}.
 * @remarks This error guarantees the refused operation started no runtime work.
 * Its cause identifies the admission failure independently of display text.
 */
export function createLlmServiceBusyError(): Error {
  return new Error("The LLM service queue is full.", {
    cause: LLM_SERVICE_BUSY_CAUSE
  })
}

/**
 * Determines whether a caught value is a recognized queue-admission failure.
 *
 * @param failure - Untrusted rejection from an application model operation.
 * @returns Whether the native error carries the private admission-failure cause.
 * @remarks Accessors are not invoked. Uninspectable values are unrecognized so
 * the caller can propagate the original failure through its normal boundary.
 */
export function isLlmServiceBusyError(failure: unknown): boolean {
  try {
    return (
      failure instanceof Error &&
      Object.getOwnPropertyDescriptor(failure, "cause")?.value ===
        LLM_SERVICE_BUSY_CAUSE
    )
  } catch {
    return false
  }
}
