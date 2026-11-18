import type { JobReportKind } from "@lys/share"
import type {
  JobReportWriter,
  NewEndReport,
  NewProgressNote
} from "../../../modules/delegation/records"
import type {
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../databaseTransactions"

/**
 * Stores one report of a reply of a job inside the caller's write
 * transaction.
 *
 * @param statements - Statement compilation lent to the caller's write
 * transaction.
 * @param report - Identity, job, reply, title, text, and time of the report.
 * @param kind - What the report says.
 * @returns True when stored; false when the job is not a stored conversation
 * with a parent, the reply is not an assistant message of it, or the report
 * is an end report and the reply already has one, each of which changes
 * nothing.
 * @throws If the write fails, including when the report's identity is
 * already stored; the caller's transaction then rolls back.
 * @remarks The report is stored undelivered and with no cited source. The
 * conflict clause names the unique index that holds end reports only, so a
 * second end report of one reply is skipped and every other conflict fails
 * the insert.
 */
function createStoredJobReport(
  statements: DatabaseStatementCompiler,
  report: NewEndReport | NewProgressNote,
  kind: JobReportKind
): boolean {
  return (
    statements
      .getStatement(
        `INSERT INTO job_reports
      (id, job_conversation_id, reply_id, kind, title, content, source_numbers,
        created_at)
      SELECT $id, j.id, r.id, $kind, $title, $content, '[]', $createdAt
      FROM conversations j
      JOIN conversation_messages r ON r.conversation_id = j.id
      WHERE j.id = $jobId AND j.parent_conversation_id IS NOT NULL
        AND r.id = $replyId AND r.role = 'assistant'
      ON CONFLICT (reply_id) WHERE kind <> 'note' DO NOTHING`
      )
      .run({
        id: report.id,
        kind,
        title: report.title,
        content: report.content,
        createdAt: report.createdAt,
        jobId: report.jobId,
        replyId: report.replyId
      }).changes === 1
  )
}

/**
 * Stores a progress note in place of its job's undelivered notes inside the
 * caller's write transaction.
 *
 * @param statements - Statement compilation lent to the caller's write
 * transaction.
 * @param note - The complete note.
 * @returns True when stored, after every other undelivered note of the job
 * is deleted; false when the reply is not a reply of that job, which changes
 * nothing.
 * @throws If a write fails, including when the note's identity is already
 * stored; the caller's transaction then rolls back, so the job's notes stay.
 */
function createStoredProgressNote(
  statements: DatabaseStatementCompiler,
  note: NewProgressNote
): boolean {
  if (!createStoredJobReport(statements, note, "note")) return false
  statements
    .getStatement(
      `DELETE FROM job_reports
      WHERE job_conversation_id = ? AND kind = 'note'
        AND delivered_message_id IS NULL AND id <> ?`
    )
    .run(note.jobId, note.id)
  return true
}

/**
 * Borrows the shared database's write transactions to store the reports jobs
 * send to their delegators.
 *
 * @remarks Invariant: each call is one write transaction that commits before
 * it returns and changes nothing when it fails. Owns no resource: the
 * database's owner closes the connection, after which every operation fails
 * with `Database is closed`. Concurrency model: single-owner, synchronous on
 * the backend's event loop. Implements {@link JobReportWriter}.
 */
export default class SqliteJobReportWriter implements JobReportWriter {
  /** Borrowed write transactions for every report. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed write access without performing database work.
   * @param databaseWriter - Write transactions lent by the database owner.
   */
  public constructor(databaseWriter: DatabaseWriter) {
    this.#databaseWriter = databaseWriter
  }

  /**
   * Implements {@link JobReportWriter.createEndReport}; the schema's unique
   * index over end reports keeps one for a reply.
   * @param report - Interface-defined report.
   * @returns The interface-defined storage outcome.
   * @throws The interface-defined closed and write failures.
   */
  public createEndReport(report: NewEndReport): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      createStoredJobReport(statements, report, report.kind)
    )
  }

  /**
   * Implements {@link JobReportWriter.createProgressNote}; the note is
   * stored before the notes it replaces are deleted.
   * @param note - Interface-defined note.
   * @returns The interface-defined storage outcome.
   * @throws The interface-defined closed and write failures.
   */
  public createProgressNote(note: NewProgressNote): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      createStoredProgressNote(statements, note)
    )
  }
}
