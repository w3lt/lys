/**
 * What reading the saved identifiers of the model instances Lys loaded found.
 *
 * @remarks `read`: the saved identifiers; empty when nothing was ever saved.
 * `unreadable`: the saved record exists but cannot be read, so which
 * instances Lys loaded is unknown. Unreadable is never reported as empty, and
 * a record that cannot be read must not be replaced.
 */
export type LysLlmInstanceIdentifiersRead =
  | Readonly<{
      /** The saved record was read. */
      status: "read"
      /** LM Studio identifiers of the instances Lys loaded; owned by the caller. */
      instanceIdentifiers: ReadonlySet<string>
    }>
  | Readonly<{
      /** The saved record exists but cannot be read. */
      status: "unreadable"
      /** Non-empty reason, suitable for logs; it never quotes the record. */
      message: string
    }>

/**
 * Keeps the LM Studio identifiers of the model instances Lys loaded, across
 * restarts of the backend, for the LLM service.
 *
 * @remarks An identifier says only that Lys loaded an instance under it; the
 * instance can be gone. Concurrency model: single-owner; the LLM service
 * makes every call inside its queued model operations, so calls never
 * overlap.
 */
export interface LysLlmInstanceStore {
  /**
   * Reads the saved identifiers.
   *
   * @returns The identifiers, or `unreadable` as
   * {@link LysLlmInstanceIdentifiersRead} describes. Each call reads again.
   * @throws Only on a failure that is not about the record itself, such as
   * failing to release what the read opened.
   */
  readLysLlmInstanceIdentifiers(): Promise<LysLlmInstanceIdentifiersRead>

  /**
   * Replaces the saved identifiers with these, as one whole record.
   *
   * @param instanceIdentifiers - Non-empty LM Studio identifiers to keep; an
   * empty set keeps none.
   * @returns A promise resolving once the record is saved; a later read
   * returns exactly these identifiers.
   * @throws If the record cannot be saved; the earlier record then stays
   * whole, or the save happened.
   */
  saveLysLlmInstanceIdentifiers(
    instanceIdentifiers: ReadonlySet<string>
  ): Promise<void>
}
