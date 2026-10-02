import { onTestFinished } from "vitest"
import SqliteConversationStore from "../../../src/di/services/conversationService"
import { calculateConversationSearchMatch } from "../../../src/di/services/conversationService/listConversations"
import type { DatabaseWriter } from "../../../src/infrastructure/database/databaseTransactions"
import SqliteDatabase from "../../../src/infrastructure/database/sqliteDatabase"

/** Stored conversation columns written by {@link saveConversationRow}. */
export type ConversationRowFixture = Readonly<{
  /** Conversation identity. */
  id: string
  /** Stored title, or null while untitled. */
  title: string | null
  /** Stored system prompt. */
  systemPrompt: string
  /** Creation time; also the initial activity time. */
  createdAt: string
}>

/** Stored user-message columns written by {@link saveUserMessageRow}. */
export type UserMessageRowFixture = Readonly<{
  /** Message identity. */
  id: string
  /** Owning conversation identity. */
  conversationId: string
  /** Non-empty authored content. */
  content: string
  /** Creation time; becomes the conversation's activity time. */
  createdAt: string
}>

/** Stored assistant-message columns written by {@link saveAssistantMessageRow}. */
export type AssistantMessageRowFixture = Readonly<{
  /** Message identity. */
  id: string
  /** Owning conversation identity. */
  conversationId: string
  /** Generating model. */
  model: string
  /** Stored reply text. */
  content: string
  /** Stored lifecycle status. */
  status: "streaming" | "completed" | "interrupted" | "failed"
  /** Stored finish reason, non-null only for completed replies. */
  finishReason: "stop" | "length" | null
  /** Creation time; becomes the conversation's activity time. */
  createdAt: string
  /** Last modification time. */
  updatedAt: string
}>

/**
 * Opens a migrated backend database owned by the current test.
 *
 * @param databaseFilePath - SQLite location; an isolated in-memory database
 * when omitted.
 * @returns The open database. It is closed when the test finishes; closing is
 * idempotent, so a case may close it earlier.
 */
function openTestDatabase(databaseFilePath = ":memory:"): SqliteDatabase {
  const database = SqliteDatabase.open(databaseFilePath)
  onTestFinished(() => {
    database[Symbol.dispose]()
  })
  return database
}

/**
 * Opens an in-memory backend database for conversation queries, owned by the
 * current test.
 *
 * @returns A database with foreign keys enforced and the `contains_search`
 * function registered, as the conversation store provides to its queries. It
 * is closed when the test finishes.
 */
export function openConversationTestDatabase(): SqliteDatabase {
  const database = openTestDatabase()
  database.registerDatabaseFunction(
    "contains_search",
    calculateConversationSearchMatch
  )
  return database
}

/** A conversation store and the test-owned database it borrows. */
export type ConversationTestStore = Readonly<{
  /** Database closed when the test finishes; a case may close it earlier. */
  database: SqliteDatabase
  /** Ready store over {@link ConversationTestStore.database}. */
  store: SqliteConversationStore
}>

/**
 * Creates a conversation store over its own backend database, owned by the
 * current test.
 *
 * @param databaseFilePath - SQLite location; an isolated in-memory database
 * when omitted.
 * @returns The ready store and the database it borrows.
 */
export function openConversationTestStore(
  databaseFilePath: string = ":memory:"
): ConversationTestStore {
  const database = openTestDatabase(databaseFilePath)
  const store = SqliteConversationStore.create({
    databaseReader: database,
    databaseWriter: database,
    databaseFunctionRegistry: database
  })
  return { database, store }
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
      .createStatement(
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
      .createStatement(
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
      .createStatement(
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
