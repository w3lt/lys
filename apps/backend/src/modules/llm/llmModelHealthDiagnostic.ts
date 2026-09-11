/**
 * Observes one retained model-health failure at the application logging boundary.
 *
 * @param failure - Original caught value borrowed only for this synchronous call.
 * @remarks The reporter must neither mutate nor retain the supplied evidence.
 */
export type LlmModelHealthFailureReporter = (failure: unknown) => void

/**
 * Opaque handle for failure evidence retained by a model-health observation.
 *
 * @remarks Implementations preserve the caught value without exposing it as
 * passive result data. Reporting is synchronous, does not transfer ownership,
 * and supplies the same retained value to the caller-provided reporter. A
 * consumer must report every returned diagnostic before completing its boundary
 * response and must not retain or mutate the supplied evidence.
 */
export interface LlmModelHealthDiagnostic {
  /**
   * Handles a request to report the retained inventory failure.
   *
   * @param reporter - Synchronous reporting boundary receiving the original caught value.
   * @throws An aggregate containing the retained failure followed by the
   * reporter failure if reporting does not complete.
   */
  handleLlmModelHealthFailureReport(
    reporter: LlmModelHealthFailureReporter
  ): void
}

/**
 * Owns one opaque failure reference for controlled diagnostic reporting.
 *
 * @remarks Primary category: invariant owner. The retained evidence is never
 * exposed as passive data and can only be observed through the synchronous
 * reporting capability. Instances are immutable after construction.
 * Concurrency model: reentrant; reporting performs no state transition, and
 * every concurrent reporter has the same synchronous observation restriction.
 */
class RetainedLlmModelHealthDiagnostic implements LlmModelHealthDiagnostic {
  /** Original caught value retained without inspection or transformation. */
  readonly #failure: unknown

  /**
   * Creates a diagnostic owner for one caught inventory failure.
   *
   * @param failure - Original untrusted value rejected by the runtime query.
   */
  public constructor(failure: unknown) {
    this.#failure = failure
  }

  /**
   * Implements {@link LlmModelHealthDiagnostic.handleLlmModelHealthFailureReport}.
   *
   * @param reporter - Synchronous reporting boundary receiving the retained value.
   * @throws An aggregate containing the retained failure followed by the
   * reporter failure if reporting does not complete.
   */
  public handleLlmModelHealthFailureReport(
    reporter: LlmModelHealthFailureReporter
  ): void {
    try {
      reporter(this.#failure)
    } catch (reporterFailure) {
      throw new AggregateError(
        [this.#failure, reporterFailure],
        "Reporting the LLM model health failure did not complete.",
        { cause: reporterFailure }
      )
    }
  }
}

/**
 * Creates an immutable diagnostic handle retaining original failure evidence.
 *
 * @param failure - Original untrusted value rejected by the runtime query.
 * @returns A frozen handle exposing only controlled synchronous reporting.
 */
export function createLlmModelHealthDiagnostic(
  failure: unknown
): LlmModelHealthDiagnostic {
  return Object.freeze(new RetainedLlmModelHealthDiagnostic(failure))
}
