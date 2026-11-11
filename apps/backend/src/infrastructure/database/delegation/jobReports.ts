import { jobReportSchema, type JobReport } from "@lys/share"
import type { DatabaseStatementCompiler } from "../databaseTransactions"

/** One stored row as SQLite returns it, before validation. */
type StoredRow = Record<string, unknown>

/**
 * Validated reports the user messages of one conversation delivered, by the
 * stored identity of the delivering message.
 */
export type DeliveredJobReports = ReadonlyMap<unknown, readonly JobReport[]>

/**
 * Projects one stored report row, joined with its job, into the shape the
 * report schema validates.
 *
 * @param row - Untrusted row with the columns `id`, `jobId`, `jobNumber`,
 * `agentCode`, `title`, `kind`, `content`, `sourceNumbers`, and `createdAt`.
 * @returns The untrusted projection, its source numbers decoded from JSON.
 */
function buildStoredJobReport(row: StoredRow): unknown {
  const sourceNumbers: unknown =
    typeof row.sourceNumbers === "string"
      ? JSON.parse(row.sourceNumbers)
      : row.sourceNumbers
  return {
    id: row.id,
    jobId: row.jobId,
    jobNumber: row.jobNumber,
    agentCode: row.agentCode,
    title: row.title,
    kind: row.kind,
    content: row.content,
    sourceNumbers,
    createdAt: row.createdAt
  }
}

/**
 * Reads the reports the user messages of one conversation delivered.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param conversationId - Stored UUIDv7 of the conversation whose messages
 * delivered the reports.
 * @returns Each message's validated reports, oldest first and then by
 * identity, each with the number and the agent of its job; a message that
 * delivered none has no entry.
 * @throws If SQLite access or persisted validation fails.
 */
export function listDeliveredJobReports(
  statements: DatabaseStatementCompiler,
  conversationId: string
): DeliveredJobReports {
  const rows = statements
    .getStatement(
      `SELECT r.delivered_message_id AS deliveredMessageId, r.id,
    r.job_conversation_id AS jobId, j.job_number AS jobNumber,
    j.agent_code AS agentCode, r.title, r.kind, r.content,
    r.source_numbers AS sourceNumbers, r.created_at AS createdAt
    FROM conversation_messages d
    JOIN job_reports r ON r.delivered_message_id = d.id
    JOIN conversations j ON j.id = r.job_conversation_id
    WHERE d.conversation_id = ? ORDER BY r.created_at, r.id`
    )
    .all(conversationId)
  const reportsByMessage = new Map<unknown, JobReport[]>()
  for (const row of rows) {
    const reports = reportsByMessage.get(row.deliveredMessageId) ?? []
    reports.push(jobReportSchema.parse(buildStoredJobReport(row)))
    reportsByMessage.set(row.deliveredMessageId, reports)
  }
  return reportsByMessage
}
