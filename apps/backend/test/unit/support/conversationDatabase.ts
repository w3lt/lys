import { onTestFinished } from "vitest"
import * as z from "zod"
import {
  isAnsweredToolCall,
  jobReportKindSchema,
  type ConversationSource,
  type ReplyPart
} from "@lys/share"
import StoredConversationHistoryEditor from "../../../src/modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../../../src/modules/conversation/historyReader"
import StoredReplyParts from "../../../src/modules/conversation/replyParts"
import StoredConversationTurns from "../../../src/modules/conversation/turns"
import SqliteConversationRecordEditor from "../../../src/infrastructure/database/conversations/sqliteConversationRecordEditor"
import SqliteConversationRecordReader from "../../../src/infrastructure/database/conversations/sqliteConversationRecordReader"
import SqliteConversationTurnRecordWriter from "../../../src/infrastructure/database/conversations/sqliteConversationTurnRecordWriter"
import SqliteReplyPartRecordWriter from "../../../src/infrastructure/database/conversations/sqliteReplyPartRecordWriter"
import type {
  DatabaseReader,
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../../../src/infrastructure/database/databaseTransactions"
import SqliteDatabase from "../../../src/infrastructure/database/sqliteDatabase"
import type {
  AssistantMessageRowFixture,
  ConversationRecordsHarness,
  ConversationRowFixture,
  JobReportRowFixture,
  JobSeedingHarness,
  UserMessageRowFixture
} from "./conversationRecordsContract"

/**
 * Opens a migrated backend database owned by the current test.
 *
 * @param databaseFilePath - SQLite location; an isolated in-memory database
 * when omitted.
 * @returns The open database, with no application SQL function registered. It
 * is closed when the test finishes; closing is idempotent, so a case may close
 * it earlier.
 */
export function openTestDatabase(
  databaseFilePath = ":memory:"
): SqliteDatabase {
  const database = SqliteDatabase.open(databaseFilePath)
  onTestFinished(() => {
    database[Symbol.dispose]()
  })
  return database
}

/**
 * Creates the Sqlite conversation records over their own backend database,
 * owned by the current test.
 *
 * @param databaseFilePath - SQLite location; an isolated in-memory database
 * when omitted.
 * @returns The records, row-level seeding and report listing of the same
 * database, and its close. The turn records are created directly, so no
 * startup recovery runs.
 */
export function openSqliteConversationRecords(
  databaseFilePath = ":memory:"
): ConversationRecordsHarness & Readonly<{ database: SqliteDatabase }> {
  const database = openTestDatabase(databaseFilePath)
  return {
    database,
    recordReader: SqliteConversationRecordReader.create(database),
    recordEditor: new SqliteConversationRecordEditor(database),
    turnRecordWriter: new SqliteConversationTurnRecordWriter(database),
    replyPartRecordWriter: new SqliteReplyPartRecordWriter(database),
    saveConversation: (row) => {
      saveConversationRow(database, row)
    },
    saveUserMessage: (row) => {
      saveUserMessageRow(database, row)
    },
    saveAssistantMessage: (row) => {
      saveAssistantMessageRow(database, row)
    },
    saveSource: (conversationId, source) => {
      saveSourceRow(database, conversationId, source)
    },
    saveJobReport: (row) => {
      saveJobReportRow(database, row)
    },
    listJobReports: () => listJobReportRows(database),
    closeRecords: () => {
      database[Symbol.dispose]()
    }
  }
}

/** The conversation services over one test-owned database. */
export type ConversationTestServices = Readonly<{
  /** Database closed when the test finishes; a case may close it earlier. */
  database: SqliteDatabase
  /** Ready turn persistence over {@link ConversationTestServices.database}. */
  turns: StoredConversationTurns
  /** Reply-part persistence over {@link ConversationTestServices.database}. */
  replyParts: StoredReplyParts
  /** History reading over {@link ConversationTestServices.database}. */
  history: StoredConversationHistoryReader
  /** History editing over {@link ConversationTestServices.database}. */
  editor: StoredConversationHistoryEditor
}>

/**
 * Creates the conversation services over Sqlite records on their own backend
 * database, owned by the current test, in the order the composition root
 * creates them.
 *
 * @param databaseFilePath - SQLite location; an isolated in-memory database
 * when omitted.
 * @returns The ready services and the database their records borrow.
 */
export function openConversationTestServices(
  databaseFilePath: string = ":memory:"
): ConversationTestServices {
  const database = openTestDatabase(databaseFilePath)
  const turns = StoredConversationTurns.create(
    new SqliteConversationTurnRecordWriter(database)
  )
  const replyParts = new StoredReplyParts(
    new SqliteReplyPartRecordWriter(database)
  )
  const history = new StoredConversationHistoryReader(
    SqliteConversationRecordReader.create(database)
  )
  const editor = new StoredConversationHistoryEditor(
    new SqliteConversationRecordEditor(database)
  )
  return { database, turns, replyParts, history, editor }
}

/**
 * Inserts one conversation row.
 *
 * @param database - Write access to a migrated test database.
 * @param row - Stored column values; a row without a parent and a job number
 * is a main conversation.
 */
export function saveConversationRow(
  database: DatabaseWriter,
  row: ConversationRowFixture
): void {
  const values = [
    row.id,
    row.title,
    row.agentCode,
    row.createdAt,
    row.createdAt,
    row.parentConversationId ?? null,
    row.jobNumber ?? null
  ]
  database.handleDatabaseWriteRequest((statements) => {
    statements
      .getStatement(
        `INSERT INTO conversations (id, title, agent_code, created_at, updated_at,
      parent_conversation_id, job_number) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...values)
  })
}

/**
 * Inserts one user-message row and a row for each of its attachments.
 *
 * @param database - Write access to a migrated test database.
 * @param row - Stored column values; a row without an origin is the person's
 * message.
 * @remarks The schema's insert trigger sets the conversation's activity time
 * to `createdAt`. Insert messages in ascending time order after the
 * conversation's creation; an earlier time makes the schema substitute the
 * real clock, and the resulting order is not controlled by the test.
 */
export function saveUserMessageRow(
  database: DatabaseWriter,
  row: UserMessageRowFixture
): void {
  database.handleDatabaseWriteRequest((statements) => {
    saveMessageRow(statements, row)
    saveAttachmentRows(statements, row)
  })
}

/**
 * Inserts the row of a user message, without its attachments.
 *
 * @param statements - Compilation lent to the running write operation.
 * @param row - Stored column values of the message.
 */
function saveMessageRow(
  statements: DatabaseStatementCompiler,
  row: UserMessageRowFixture
): void {
  statements
    .getStatement(
      `INSERT INTO conversation_messages
      (id, conversation_id, role, content, created_at, origin, job_call_id)
      VALUES (?, ?, 'user', ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.conversationId,
      row.content,
      row.createdAt,
      row.origin ?? null,
      row.jobCallId ?? null
    )
}

/**
 * Inserts the rows of a user message's attachments.
 *
 * @param statements - Compilation lent to the running write operation.
 * @param row - The message whose attachments are inserted.
 */
function saveAttachmentRows(
  statements: DatabaseStatementCompiler,
  row: UserMessageRowFixture
): void {
  const insertAttachment = statements.getStatement(
    `INSERT INTO conversation_attachments
      (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const attachment of row.attachments ?? [])
    insertAttachment.run(
      row.conversationId,
      row.id,
      attachment.number,
      attachment.name,
      attachment.kind,
      attachment.kind === "image" ? attachment.mediaType : null,
      attachment.sizeBytes,
      attachment.kind === "image" ? attachment.width : null,
      attachment.kind === "image" ? attachment.height : null
    )
}

/**
 * Inserts one assistant-message row and a row for each of its parts.
 *
 * @param database - Write access to a migrated test database.
 * @param row - Stored column values; the reply row holds no text and each
 * part becomes one row at its position.
 * @remarks The ordering constraint of {@link saveUserMessageRow} applies, to
 * the reply and its parts alike.
 */
export function saveAssistantMessageRow(
  database: DatabaseWriter,
  row: AssistantMessageRowFixture
): void {
  database.handleDatabaseWriteRequest((statements) => {
    saveReplyRow(statements, row)
    saveReplyPartRows(statements, row)
  })
}

/**
 * Builds the controls that store a job fixture's rows on a test database.
 *
 * @param database - Write access to a migrated test database.
 * @returns Controls that store conversation, user-message, and
 * assistant-message rows, as {@link saveConversationRow},
 * {@link saveUserMessageRow}, and {@link saveAssistantMessageRow} do.
 */
export function createJobSeedingHarness(
  database: DatabaseWriter
): JobSeedingHarness {
  return {
    saveConversation: (row) => {
      saveConversationRow(database, row)
    },
    saveUserMessage: (row) => {
      saveUserMessageRow(database, row)
    },
    saveAssistantMessage: (row) => {
      saveAssistantMessageRow(database, row)
    }
  }
}

/**
 * Lists the column values of one stored part, in the order the part insert
 * of {@link saveAssistantMessageRow} binds them.
 *
 * @param reply - Reply the part belongs to.
 * @param part - Part to store.
 * @param position - Its position in the reply.
 * @returns The bound values.
 */
function buildPartRowValues(
  reply: AssistantMessageRowFixture,
  part: ReplyPart,
  position: number
): (string | number | null)[] {
  const common = [part.id, reply.conversationId]
  const times = [part.createdAt, part.updatedAt]
  if (part.kind !== "tool-call")
    return [
      ...common,
      part.kind,
      reply.id,
      position,
      part.round,
      part.content,
      null,
      null,
      null,
      null,
      ...times
    ]
  return [
    ...common,
    "tool_call",
    reply.id,
    position,
    part.round,
    isAnsweredToolCall(part) ? part.result : "",
    part.status,
    part.toolName,
    part.argumentText,
    part.status === "succeeded" && part.sourceNumbers.length > 0
      ? JSON.stringify(part.sourceNumbers)
      : null,
    ...times
  ]
}

/**
 * Inserts the row of a reply, without its parts.
 *
 * @param statements - Compilation lent to the running write operation.
 * @param row - Stored column values of the reply.
 */
function saveReplyRow(
  statements: DatabaseStatementCompiler,
  row: AssistantMessageRowFixture
): void {
  statements
    .getStatement(
      `INSERT INTO conversation_messages
      (id, conversation_id, role, model, provider, content, status, finish_reason, created_at, updated_at)
      VALUES (?, ?, 'assistant', ?, ?, '', ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.conversationId,
      row.model,
      row.provider,
      row.status,
      row.finishReason,
      row.createdAt,
      row.updatedAt
    )
}

/**
 * Inserts the rows of a reply's parts in stored order.
 *
 * @param statements - Compilation lent to the running write operation.
 * @param row - The reply whose parts are inserted.
 */
function saveReplyPartRows(
  statements: DatabaseStatementCompiler,
  row: AssistantMessageRowFixture
): void {
  const insertPart = statements.getStatement(
    `INSERT INTO conversation_messages
      (id, conversation_id, role, reply_id, position, round, content, status,
        tool_name, tool_arguments, source_numbers, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  row.parts.forEach((part, position) => {
    insertPart.run(...buildPartRowValues(row, part, position))
  })
}

/**
 * Inserts one source row.
 *
 * @param database - Write access to a migrated test database.
 * @param conversationId - Stored conversation the source belongs to.
 * @param source - Stored column values.
 */
export function saveSourceRow(
  database: DatabaseWriter,
  conversationId: string,
  source: ConversationSource
): void {
  database.handleDatabaseWriteRequest((statements) => {
    statements
      .getStatement(
        `INSERT INTO conversation_sources (conversation_id, number, url, title)
      VALUES (?, ?, ?, ?)`
      )
      .run(conversationId, source.number, source.url, source.title)
  })
}

/**
 * Inserts one job-report row.
 *
 * @param database - Write access to a migrated test database.
 * @param row - Stored column values; the source numbers are stored as JSON.
 */
export function saveJobReportRow(
  database: DatabaseWriter,
  row: JobReportRowFixture
): void {
  const values = [
    row.id,
    row.jobId,
    row.replyId,
    row.kind,
    row.title,
    row.content,
    JSON.stringify(row.sourceNumbers),
    row.createdAt,
    row.deliveredMessageId
  ]
  database.handleDatabaseWriteRequest((statements) => {
    statements
      .getStatement(
        `INSERT INTO job_reports (id, job_conversation_id, reply_id, kind, title, content,
      source_numbers, created_at, delivered_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...values)
  })
}

/**
 * Projects one stored job-report row into the values it was saved from.
 *
 * @param row - Untrusted stored row selected by
 * {@link listStoredJobReportRows}.
 * @returns The row with its source numbers decoded.
 * @throws If the row is not a job-report row, or its source numbers are not
 * a JSON list of numbers.
 */
function parseJobReportRow(row: Record<string, unknown>): JobReportRowFixture {
  /**
   * Validates one stored job-report row once its source numbers are decoded.
   */
  const jobReportRowSchema = z.strictObject({
    id: z.string(),
    jobId: z.string(),
    replyId: z.string(),
    kind: jobReportKindSchema,
    title: z.string(),
    content: z.string(),
    sourceNumbers: z.array(z.number()),
    createdAt: z.string(),
    deliveredMessageId: z.string().nullable()
  })

  const sourceNumbers: unknown =
    typeof row.sourceNumbers === "string"
      ? JSON.parse(row.sourceNumbers)
      : row.sourceNumbers
  return jobReportRowSchema.parse({
    id: row.id,
    jobId: row.jobId,
    replyId: row.replyId,
    kind: row.kind,
    title: row.title,
    content: row.content,
    sourceNumbers,
    createdAt: row.createdAt,
    deliveredMessageId: row.deliveredMessageId
  })
}

/**
 * Reads every stored job-report row inside the caller's read operation.
 *
 * @param statements - Compilation lent to the running read operation.
 * @returns The rows in creation-time and then identity order.
 * @throws If a stored row is not a job-report row.
 */
function listStoredJobReportRows(
  statements: DatabaseStatementCompiler
): JobReportRowFixture[] {
  return statements
    .getStatement(
      `SELECT id, job_conversation_id AS jobId, reply_id AS replyId, kind, title,
      content, source_numbers AS sourceNumbers, created_at AS createdAt,
      delivered_message_id AS deliveredMessageId
      FROM job_reports ORDER BY created_at, id`
    )
    .all()
    .map((row) => parseJobReportRow(row))
}

/**
 * Lists every stored job-report row.
 *
 * @param database - Read access to a migrated test database.
 * @returns The rows in creation-time and then identity order, as
 * {@link saveJobReportRow} takes them.
 */
export function listJobReportRows(
  database: DatabaseReader
): JobReportRowFixture[] {
  return database.handleDatabaseReadRequest((statements) =>
    listStoredJobReportRows(statements)
  )
}

/**
 * Reads every stored tool call decision record.
 *
 * @param database - Read access to a migrated test database.
 * @returns Each record's columns by name, ordered by call.
 */
export function readToolCallDecisionRows(
  database: DatabaseReader
): Record<string, unknown>[] {
  return database.handleDatabaseReadRequest((statements) =>
    statements
      .getStatement(
        `SELECT call_id AS callId, conversation_id AS conversationId,
        agent_code AS agentCode, tool_name AS toolName,
        policy_effect AS policyEffect, policy_reason AS policyReason,
        policy_id AS policyId, approval_mode AS approvalMode, answer, outcome,
        created_at AS createdAt, updated_at AS updatedAt
        FROM tool_call_decisions ORDER BY call_id`
      )
      .all()
  )
}
