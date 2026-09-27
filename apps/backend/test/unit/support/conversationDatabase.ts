import { DatabaseSync } from "node:sqlite"
import { onTestFinished } from "vitest"
import { calculateConversationSearchMatch } from "../../../src/di/services/conversationService/listConversations"
import { migrateDatabase } from "../../../src/di/services/conversationService/migrations"

/** Stored conversation columns written by {@link insertConversationRow}. */
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

/** Stored user-message columns written by {@link insertUserMessageRow}. */
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

/** Stored assistant-message columns written by {@link insertAssistantMessageRow}. */
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
 * Opens a migrated in-memory conversation database owned by the current test.
 *
 * @returns A connection with foreign keys enforced and the `contains_search`
 * function available, as the conversation store provides to its queries.
 * @remarks The connection is closed when the test finishes.
 */
export function openConversationTestDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:")
  onTestFinished(() => {
    database.close()
  })
  database.exec("PRAGMA foreign_keys = ON")
  database.function(
    "contains_search",
    { deterministic: true },
    calculateConversationSearchMatch
  )
  migrateDatabase(database)
  return database
}

/**
 * Inserts one conversation row.
 *
 * @param database - Migrated test database.
 * @param row - Stored column values.
 */
export function insertConversationRow(
  database: DatabaseSync,
  row: ConversationRowFixture
): void {
  database
    .prepare(
      `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`
    )
    .run(row.id, row.title, row.systemPrompt, row.createdAt, row.createdAt)
}

/**
 * Inserts one user-message row.
 *
 * @param database - Migrated test database.
 * @param row - Stored column values.
 * @remarks The schema's insert trigger sets the conversation's activity time
 * to `createdAt`. Insert messages in ascending time order after the
 * conversation's creation; an earlier time makes the schema substitute the
 * real clock, and the resulting order is not controlled by the test.
 */
export function insertUserMessageRow(
  database: DatabaseSync,
  row: UserMessageRowFixture
): void {
  database
    .prepare(
      `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, ?)`
    )
    .run(row.id, row.conversationId, row.content, row.createdAt)
}

/**
 * Inserts one assistant-message row.
 *
 * @param database - Migrated test database.
 * @param row - Stored column values.
 * @remarks The ordering constraint of {@link insertUserMessageRow} applies.
 */
export function insertAssistantMessageRow(
  database: DatabaseSync,
  row: AssistantMessageRowFixture
): void {
  database
    .prepare(
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
}
