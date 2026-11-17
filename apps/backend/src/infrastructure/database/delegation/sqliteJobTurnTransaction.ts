import type { ConversationSource, JobReport } from "@lys/share"
import type {
  JobReportDelivery,
  JobTurnTransaction
} from "../../../modules/conversation/records"
import type { DatabaseStatementCompiler } from "../databaseTransactions"
import { listUndeliveredJobReports } from "./jobReports"

/**
 * Reads and writes what one turn changes about jobs through the statement
 * compiler lent to one write operation.
 *
 * @remarks Invariant: it reaches the database only through the lent compiler,
 * so once that operation returns, every call fails with
 * `Database operation has ended` before running SQL. Resource ownership: the
 * compiler is borrowed for the operation's duration; nothing is released here.
 * Concurrency model: single-owner, confined to the running operation.
 * Implements {@link JobTurnTransaction}.
 */
export default class SqliteJobTurnTransaction implements JobTurnTransaction {
  /** Statement compilation lent to the enclosing write operation. */
  readonly #statements: DatabaseStatementCompiler

  /**
   * Retains the compiler lent to the operation about to run.
   * @param statements - Compilation valid until the operation returns.
   */
  public constructor(statements: DatabaseStatementCompiler) {
    this.#statements = statements
  }

  /**
   * Implements {@link JobTurnTransaction.updateJobTitle}; only a row with a
   * parent is a job, and no trigger moves its activity time.
   * @param jobId - Interface-defined job.
   * @param title - Interface-defined title.
   * @throws The interface-defined ended-transaction and write failures; an
   * empty title fails the check constraint of a job's row.
   */
  public updateJobTitle(jobId: string, title: string): void {
    this.#statements
      .getStatement(
        `UPDATE conversations SET title = ?
    WHERE id = ? AND parent_conversation_id IS NOT NULL`
      )
      .run(title, jobId)
  }

  /**
   * Implements {@link JobTurnTransaction.listUndeliveredJobReports}.
   * @param parentConversationId - Interface-defined conversation.
   * @returns The interface-defined reports.
   * @throws The interface-defined ended-transaction and validation failures.
   */
  public listUndeliveredJobReports(
    parentConversationId: string
  ): readonly JobReport[] {
    return listUndeliveredJobReports(this.#statements, parentConversationId)
  }

  /**
   * Implements {@link JobTurnTransaction.updateJobReportToDelivered}; the
   * source numbers are stored as a JSON list.
   * @param delivery - Interface-defined delivery.
   * @throws The interface-defined failures; a message that is not stored
   * fails the foreign-key constraint, an empty text of a note or of a
   * `failed` report one check constraint, and a text or a source number of a
   * `stopped` or an `interrupted` report another.
   */
  public updateJobReportToDelivered(delivery: JobReportDelivery): void {
    /** What a delivery fails with when its report does not wait for one. */
    const reportNotWaitingMessage = "Job report is not waiting for delivery"

    const { changes } = this.#statements
      .getStatement(
        `UPDATE job_reports
    SET delivered_message_id = $messageId, content = $content,
      source_numbers = $sourceNumbers
    WHERE id = $reportId AND delivered_message_id IS NULL`
      )
      .run({
        messageId: delivery.messageId,
        content: delivery.content,
        sourceNumbers: JSON.stringify(delivery.sourceNumbers),
        reportId: delivery.reportId
      })
    if (changes !== 1) throw new Error(reportNotWaitingMessage)
  }

  /**
   * Implements {@link JobTurnTransaction.createConversationSource}; no
   * trigger moves the conversation's activity time.
   * @param conversationId - Interface-defined conversation.
   * @param source - Interface-defined source.
   * @throws The interface-defined failures; a conversation that is not stored
   * fails the foreign-key constraint, a number one of its sources has the
   * primary key, and a URL one of them has the unique constraint.
   */
  public createConversationSource(
    conversationId: string,
    source: ConversationSource
  ): void {
    this.#statements
      .getStatement(
        `INSERT INTO conversation_sources (conversation_id, number, url, title)
    VALUES (?, ?, ?, ?)`
      )
      .run(conversationId, source.number, source.url, source.title)
  }
}
