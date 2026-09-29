/** Private native-error cause identifying work without a connected LLM runtime. */
const LLM_RUNTIME_UNAVAILABLE_CAUSE = Symbol("llm-runtime-unavailable")

/**
 * Creates a failure for a model operation that has no connected LLM runtime.
 *
 * @param runtimeFailures - Original failures that revealed a lost connection;
 * empty when the operation was refused before any runtime work.
 * @returns A new aggregate error recognized by {@link isLlmRuntimeUnavailableError}.
 * @remarks The cause marker identifies the category independently of display
 * text, while `errors` retains every original failure as evidence.
 */
export function createLlmRuntimeUnavailableError(
  runtimeFailures: readonly unknown[]
): AggregateError {
  return new AggregateError(
    runtimeFailures,
    "The LLM runtime is unavailable.",
    { cause: LLM_RUNTIME_UNAVAILABLE_CAUSE }
  )
}

/**
 * Determines whether a caught value is a recognized runtime-unavailable failure.
 *
 * @param failure - Untrusted rejection from a model operation.
 * @returns Whether the aggregate error carries the private runtime-unavailable cause.
 * @remarks Accessors are not invoked. Uninspectable values are unrecognized so
 * the caller can propagate the original failure through its normal boundary.
 */
export function isLlmRuntimeUnavailableError(
  failure: unknown
): failure is AggregateError {
  try {
    return (
      failure instanceof AggregateError &&
      Object.getOwnPropertyDescriptor(failure, "cause")?.value ===
        LLM_RUNTIME_UNAVAILABLE_CAUSE
    )
  } catch {
    return false
  }
}
