import * as z from "zod"
import { jobSchema, type Job } from "@lys/share"
import type { JobRecord } from "../../../modules/delegation/records"
import type { DatabaseStatementCompiler } from "../databaseTransactions"

/** One stored row as SQLite returns it, before validation. */
type StoredRow = Record<string, unknown>

/**
 * Selects conversations as jobs, one row each; the condition that picks the
 * jobs follows it.
 *
 * @remarks `r` is the job's reply, its newest assistant message by creation
 * time and then identity, and `e` is that reply's end report. A streaming
 * reply reads as `working`, a completed one as `replied`, a failed one as
 * `failed`, and an interrupted one as `interrupted` when its end report says
 * so and as `stopped` otherwise. The latest note is the newest note of that
 * reply, and the call ids are those of the job's messages, oldest first, as a
 * JSON list. A job without a reply has no state and no reply identity, and a
 * job without a job message has an empty list; the job schema refuses both.
 */
const SELECT_JOBS_SQL = `SELECT j.id, j.parent_conversation_id AS parentConversationId,
  j.job_number AS number, j.agent_code AS agentCode, j.title,
  CASE r.status
    WHEN 'streaming' THEN 'working'
    WHEN 'completed' THEN 'replied'
    WHEN 'failed' THEN 'failed'
    WHEN 'interrupted' THEN
      CASE e.kind WHEN 'interrupted' THEN 'interrupted' ELSE 'stopped' END
  END AS state,
  (SELECT n.content FROM job_reports n
    WHERE n.reply_id = r.id AND n.kind = 'note'
    ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS latestNote,
  r.id AS replyId,
  (SELECT json_group_array(m.job_call_id ORDER BY m.created_at, m.id)
    FROM conversation_messages m
    WHERE m.conversation_id = j.id AND m.job_call_id IS NOT NULL) AS jobCallIds,
  j.created_at AS createdAt, j.updated_at AS updatedAt
  FROM conversations j
  LEFT JOIN conversation_messages r ON r.id = (
    SELECT a.id FROM conversation_messages a
    WHERE a.conversation_id = j.id AND a.role = 'assistant'
    ORDER BY a.created_at DESC, a.id DESC LIMIT 1)
  LEFT JOIN job_reports e ON e.reply_id = r.id AND e.kind <> 'note'`

/**
 * Projects one stored job row into the shape the job schema validates.
 *
 * @param row - Untrusted row selected by {@link SELECT_JOBS_SQL}.
 * @returns The untrusted projection, its call ids decoded from JSON.
 */
function buildStoredJob(row: StoredRow): unknown {
  const jobCallIds: unknown =
    typeof row.jobCallIds === "string"
      ? JSON.parse(row.jobCallIds)
      : row.jobCallIds
  return {
    id: row.id,
    number: row.number,
    agentCode: row.agentCode,
    title: row.title,
    state: row.state,
    latestNote: row.latestNote,
    replyId: row.replyId,
    jobCallIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/**
 * Reads the jobs started from one conversation.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param parentConversationId - Stored UUIDv7 of the conversation.
 * @returns The validated jobs in number order; none when the conversation has
 * no jobs or is not stored.
 * @throws If SQLite access or persisted validation fails.
 */
export function listConversationJobs(
  statements: DatabaseStatementCompiler,
  parentConversationId: string
): Job[] {
  return statements
    .getStatement(
      `${SELECT_JOBS_SQL} WHERE j.parent_conversation_id = ? ORDER BY j.job_number`
    )
    .all(parentConversationId)
    .map((row) => jobSchema.parse(buildStoredJob(row)))
}

/**
 * Reads one job by its identity, with the conversation it belongs to.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param jobId - Stored UUIDv7 of the job: its conversation.
 * @returns The validated record, or undefined when no conversation has the
 * identity or the one that has it has no parent.
 * @throws If SQLite access or persisted validation fails.
 */
export function findJobRecord(
  statements: DatabaseStatementCompiler,
  jobId: string
): JobRecord | undefined {
  /** Validates one stored job with the conversation it belongs to. */
  const jobRecordSchema = z.strictObject({
    /** UUIDv7 of the conversation the job was started from. */
    parentConversationId: z.uuidv7(),
    /** The job, as the shared job contract defines it. */
    job: jobSchema
  })

  const row = statements
    .getStatement(
      `${SELECT_JOBS_SQL} WHERE j.id = ? AND j.parent_conversation_id IS NOT NULL`
    )
    .get(jobId)
  if (row === undefined) return undefined
  const job = buildStoredJob(row)
  return jobRecordSchema.parse({
    parentConversationId: row.parentConversationId,
    job
  })
}

/**
 * Reads one job by its number in the conversation it belongs to.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param parentConversationId - Stored UUIDv7 of the conversation the job
 * was started from.
 * @param jobNumber - The job's number in that conversation.
 * @returns The validated job, or undefined when that conversation has no job
 * with the number.
 * @throws If SQLite access or persisted validation fails.
 */
export function findJobByNumber(
  statements: DatabaseStatementCompiler,
  parentConversationId: string,
  jobNumber: number
): Job | undefined {
  const row = statements
    .getStatement(
      `${SELECT_JOBS_SQL} WHERE j.parent_conversation_id = ? AND j.job_number = ?`
    )
    .get(parentConversationId, jobNumber)
  if (row === undefined) return undefined
  return jobSchema.parse(buildStoredJob(row))
}
