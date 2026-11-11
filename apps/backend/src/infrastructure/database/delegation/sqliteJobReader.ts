import * as z from "zod"
import type { Job } from "@lys/share"
import type { JobReader, JobRecord } from "../../../modules/delegation/records"
import type {
  DatabaseReader,
  DatabaseStatementCompiler
} from "../databaseTransactions"
import { findJobByNumber, findJobRecord, listConversationJobs } from "./jobs"

/** Validates the number of job messages read as one count. */
const jobMessageCountSchema = z.strictObject({
  jobMessageCount: z.int().nonnegative()
})

/**
 * Reads how many job messages a conversation's jobs received since the person
 * last wrote in it, inside the caller's read transaction.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param parentConversationId - Stored UUIDv7 of the conversation.
 * @returns The number of job messages, over all of its jobs, created at or
 * after the latest message the person wrote in it; every one of them when the
 * person wrote none there.
 * @throws If SQLite access fails.
 * @remarks A message the person wrote is a user message without an origin,
 * so a wake-up message does not start the count again. Times are compared as
 * text, which orders the stored format by time.
 */
function getJobMessageCountSincePersonMessage(
  statements: DatabaseStatementCompiler,
  parentConversationId: string
): number {
  const { jobMessageCount } = jobMessageCountSchema.parse(
    statements
      .getStatement(
        `SELECT count(*) AS jobMessageCount FROM conversations j
      JOIN conversation_messages m ON m.conversation_id = j.id
      WHERE j.parent_conversation_id = $parentConversationId
        AND m.origin = 'delegator'
        AND m.created_at >= coalesce(
          (SELECT max(p.created_at) FROM conversation_messages p
            WHERE p.conversation_id = $parentConversationId
              AND p.role = 'user' AND p.origin IS NULL),
          '')`
      )
      .get({ parentConversationId })
  )
  return jobMessageCount
}

/**
 * Borrows the shared database's read snapshots to read the jobs of
 * conversations.
 *
 * @remarks Invariant: each call is one read snapshot that changes nothing,
 * and returned records are independent copies. Owns no resource: the
 * database's owner closes the connection, after which every operation fails
 * with `Database is closed`. Concurrency model: single-owner, synchronous on
 * the backend's event loop. Implements {@link JobReader}.
 */
export default class SqliteJobReader implements JobReader {
  /** Borrowed read snapshots for every job query. */
  readonly #databaseReader: DatabaseReader

  /**
   * Retains borrowed read access without performing database work.
   * @param databaseReader - Read snapshots lent by the database owner.
   */
  public constructor(databaseReader: DatabaseReader) {
    this.#databaseReader = databaseReader
  }

  /**
   * Implements {@link JobReader.listJobs} in one read snapshot.
   * @param parentConversationId - Interface-defined identity.
   * @returns The interface-defined jobs.
   * @throws The interface-defined closed and validation failures.
   */
  public listJobs(parentConversationId: string): readonly Job[] {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      listConversationJobs(statements, parentConversationId)
    )
  }

  /**
   * Implements {@link JobReader.findJob} in one read snapshot.
   * @param jobId - Interface-defined identity.
   * @returns The interface-defined record or absence.
   * @throws The interface-defined closed and validation failures.
   */
  public findJob(jobId: string): JobRecord | undefined {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      findJobRecord(statements, jobId)
    )
  }

  /**
   * Implements {@link JobReader.findJobByNumber} in one read snapshot.
   * @param parentConversationId - Interface-defined identity.
   * @param jobNumber - Interface-defined number.
   * @returns The interface-defined job or absence.
   * @throws The interface-defined closed and validation failures.
   */
  public findJobByNumber(
    parentConversationId: string,
    jobNumber: number
  ): Job | undefined {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      findJobByNumber(statements, parentConversationId, jobNumber)
    )
  }

  /**
   * Implements {@link JobReader.getJobMessageCountSincePersonMessage} in one
   * read snapshot.
   * @param parentConversationId - Interface-defined identity.
   * @returns The interface-defined count.
   * @throws The interface-defined closed failure.
   */
  public getJobMessageCountSincePersonMessage(
    parentConversationId: string
  ): number {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      getJobMessageCountSincePersonMessage(statements, parentConversationId)
    )
  }
}
