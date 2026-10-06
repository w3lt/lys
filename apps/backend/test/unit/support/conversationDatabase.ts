import { onTestFinished } from "vitest"
import StoredConversationHistoryEditor from "../../../src/modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../../../src/modules/conversation/historyReader"
import StoredConversationTurns from "../../../src/modules/conversation/turns"
import SqliteConversationRecordEditor from "../../../src/infrastructure/database/conversations/sqliteConversationRecordEditor"
import SqliteConversationRecordReader from "../../../src/infrastructure/database/conversations/sqliteConversationRecordReader"
import SqliteConversationTurnRecordWriter from "../../../src/infrastructure/database/conversations/sqliteConversationTurnRecordWriter"
import type { DatabaseWriter } from "../../../src/infrastructure/database/databaseTransactions"
import SqliteDatabase from "../../../src/infrastructure/database/sqliteDatabase"
import type {
  AssistantMessageRowFixture,
  ConversationRecordsHarness,
  ConversationRowFixture,
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
 * @returns The records, row-level seeding of the same database, and its close.
 * The turn records are created directly, so no startup recovery runs.
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
    saveConversation: (row) => {
      saveConversationRow(database, row)
    },
    saveUserMessage: (row) => {
      saveUserMessageRow(database, row)
    },
    saveAssistantMessage: (row) => {
      saveAssistantMessageRow(database, row)
    },
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
  const history = new StoredConversationHistoryReader(
    SqliteConversationRecordReader.create(database)
  )
  const editor = new StoredConversationHistoryEditor(
    new SqliteConversationRecordEditor(database)
  )
  return { database, turns, history, editor }
}

/**
 * Inserts one conversation row.
 *
 * @param database - Write access to a migrated test database.
 * @param row - Stored column values.
 */
export function saveConversationRow(
  database: DatabaseWriter,
  row: ConversationRowFixture
): void {
  database.handleDatabaseWriteRequest((statements) => {
    statements
      .getStatement(
        `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`
      )
      .run(row.id, row.title, row.systemPrompt, row.createdAt, row.createdAt)
  })
}

/**
 * Inserts one user-message row.
 *
 * @param database - Write access to a migrated test database.
 * @param row - Stored column values.
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
    statements
      .getStatement(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, ?)`
      )
      .run(row.id, row.conversationId, row.content, row.createdAt)
  })
}

/**
 * Inserts one assistant-message row.
 *
 * @param database - Write access to a migrated test database.
 * @param row - Stored column values.
 * @remarks The ordering constraint of {@link saveUserMessageRow} applies.
 */
export function saveAssistantMessageRow(
  database: DatabaseWriter,
  row: AssistantMessageRowFixture
): void {
  database.handleDatabaseWriteRequest((statements) => {
    statements
      .getStatement(
        `INSERT INTO conversation_messages
      (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
      VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.conversationId,
        row.model,
        row.content,
        row.status,
        row.finishReason,
        row.createdAt,
        row.updatedAt
      )
  })
}
