/**
 * Observes one retained runtime failure at the application logging boundary.
 *
 * @param failure - Original caught value borrowed only for this synchronous call.
 * @remarks The reporter must neither mutate nor retain the supplied evidence.
 */
export type LlmRuntimeFailureReporter = (failure: unknown) => void

/**
 * Opaque handle for the evidence of one failed LLM runtime operation, such
 * as a loaded-inventory query or a model stop.
 *
 * @remarks Implementations preserve the caught value without exposing it as
 * passive result data. Reporting is synchronous, does not transfer ownership,
 * and supplies the same retained value to the caller-provided reporter. A
 * consumer must report every diagnostic that carries such evidence before
 * completing its boundary response and must not retain or mutate the
 * supplied evidence.
 */
export interface LlmRuntimeFailureEvidence {
  /**
   * Handles a request to report the retained runtime failure.
   *
   * @param reporter - Synchronous reporting boundary receiving the original caught value.
   * @throws An aggregate containing the retained failure followed by the
   * reporter failure if reporting does not complete.
   */
  handleLlmRuntimeFailureReport(reporter: LlmRuntimeFailureReporter): void
}

/**
 * Owns one opaque failure reference for controlled diagnostic reporting.
 *
 * @remarks The retained evidence is never
 * exposed as passive data and can only be observed through the synchronous
 * reporting capability. Instances are immutable after construction.
 * Concurrency model: reentrant; reporting performs no state transition, and
 * every concurrent reporter has the same synchronous observation restriction.
 */
class RetainedLlmRuntimeFailureEvidence implements LlmRuntimeFailureEvidence {
  /** Original caught value retained without inspection or transformation. */
  readonly #failure: unknown

  /**
   * Creates an evidence owner for one caught runtime failure.
   *
   * @param failure - Original untrusted value rejected by the runtime operation.
   */
  public constructor(failure: unknown) {
    this.#failure = failure
  }

  /**
   * Implements {@link LlmRuntimeFailureEvidence.handleLlmRuntimeFailureReport}.
   *
   * @param reporter - Synchronous reporting boundary receiving the retained value.
   * @throws An aggregate containing the retained failure followed by the
   * reporter failure if reporting does not complete.
   */
  public handleLlmRuntimeFailureReport(
    reporter: LlmRuntimeFailureReporter
  ): void {
    try {
      reporter(this.#failure)
    } catch (reporterError) {
      throw new AggregateError(
        [this.#failure, reporterError],
        "Reporting the LLM runtime failure did not complete.",
        { cause: reporterError }
      )
    }
  }
}

/**
 * Creates an immutable evidence handle retaining one original runtime
 * failure.
 *
 * @param failure - Original untrusted value rejected by the runtime operation.
 * @returns A frozen handle exposing only controlled synchronous reporting.
 */
export function createLlmRuntimeFailureEvidence(
  failure: unknown
): LlmRuntimeFailureEvidence {
  return Object.freeze(new RetainedLlmRuntimeFailureEvidence(failure))
}
