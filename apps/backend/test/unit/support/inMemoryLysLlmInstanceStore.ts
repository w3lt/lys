import type {
  LysLlmInstanceIdentifiersRead,
  LysLlmInstanceStore
} from "../../../src/modules/llm/lysLlmInstanceStore"

/** Read result of a record nothing was saved to. */
const EMPTY_RECORD: LysLlmInstanceIdentifiersRead = Object.freeze({
  status: "read",
  instanceIdentifiers: new Set<string>()
})

/**
 * Keeps the saved identifiers in memory for tests, and lets a case start
 * from a saved or unreadable record, make saves fail, and see every save.
 *
 * @remarks Implements the {@link LysLlmInstanceStore} contract while saves
 * succeed. A record constructed unreadable stays unreadable until a save
 * replaces it, as a file would. Concurrency model: single-owner, like the
 * contract.
 */
export default class InMemoryLysLlmInstanceStore implements LysLlmInstanceStore {
  /** What the next read returns. */
  #record: LysLlmInstanceIdentifiersRead

  /** Failure every save rejects with, or undefined while saves succeed. */
  #saveFailure: Error | undefined = undefined

  /** Copy of each set saved, in save order. */
  readonly #savedIdentifierSets: ReadonlySet<string>[] = []

  /**
   * Creates a store over a record.
   *
   * @param record - What reads return before the first save; a record
   * nothing was saved to by default.
   */
  public constructor(record: LysLlmInstanceIdentifiersRead = EMPTY_RECORD) {
    this.#record = record
  }

  /**
   * Reads the record.
   *
   * @returns The record, with a new set when it was read.
   */
  public readLysLlmInstanceIdentifiers(): Promise<LysLlmInstanceIdentifiersRead> {
    const record = this.#record
    return Promise.resolve(
      record.status === "read"
        ? Object.freeze({
            status: "read",
            instanceIdentifiers: new Set(record.instanceIdentifiers)
          })
        : record
    )
  }

  /**
   * Replaces the record with a copy of the identifiers, unless saves fail.
   *
   * @param instanceIdentifiers - Identifiers to keep.
   * @returns A promise resolving after the record is replaced.
   * @throws The failure given to {@link failSaves}, leaving the record as
   * it was and recording no save.
   */
  public saveLysLlmInstanceIdentifiers(
    instanceIdentifiers: ReadonlySet<string>
  ): Promise<void> {
    if (this.#saveFailure !== undefined) {
      return Promise.reject(this.#saveFailure)
    }
    const savedIdentifiers = new Set(instanceIdentifiers)
    this.#savedIdentifierSets.push(savedIdentifiers)
    this.#record = Object.freeze({
      status: "read",
      instanceIdentifiers: savedIdentifiers
    })
    return Promise.resolve()
  }

  /**
   * Makes every later save reject.
   *
   * @param failure - Failure each save rejects with.
   */
  public failSaves(failure: Error): void {
    this.#saveFailure = failure
  }

  /**
   * Lists the sets saved so far.
   *
   * @returns Copies of the saved sets, in save order.
   */
  public listSavedIdentifierSets(): readonly ReadonlySet<string>[] {
    return this.#savedIdentifierSets.map(
      (savedIdentifiers) => new Set(savedIdentifiers)
    )
  }
}
