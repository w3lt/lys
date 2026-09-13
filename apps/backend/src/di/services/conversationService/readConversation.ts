import type { DatabaseSync } from "node:sqlite"
import {
  conversationMetadataSchema,
  conversationMessageSchema,
  type Conversation,
  type ConversationMetadata,
  type ConversationMessage
} from "@lys/share"

/**
 * Reads metadata without changing activity time.
 * @param database - Borrowed open connection.
 * @param conversationId - Stored UUIDv7 to look up.
 * @returns Independent metadata, or undefined for an absent conversation.
 * @throws If SQLite access or persisted validation fails.
 */
export function getConversationMetadata(
  database: DatabaseSync,
  conversationId: string
): ConversationMetadata | undefined {
  const row = database
    .prepare(
      `SELECT id, title, system_prompt AS systemPrompt,
    created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ?`
    )
    .get(conversationId)
  return row === undefined ? undefined : conversationMetadataSchema.parse(row)
}

/**
 * Projects role-specific SQLite columns into the strict message contract.
 * @param row - Untrusted stored row selected by getConversation.
 * @returns The validated independent message.
 * @throws If the row violates the shared message schema.
 */
function parseConversationMessage(
  row: Record<string, unknown>
): ConversationMessage {
  const common = {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt
  }
  if (row.role === "user") return conversationMessageSchema.parse(common)
  return conversationMessageSchema.parse({
    ...common,
    model: row.model,
    status: row.status,
    finishReason: row.finishReason,
    updatedAt: row.updatedAt
  })
}

/**
 * Reads a full transcript in creation-time and UUID order.
 * @param database - Borrowed open connection in the caller's read transaction.
 * @param conversationId - Stored UUIDv7 to look up.
 * @returns Independent conversation data, or undefined when absent.
 * @throws If SQLite access or persisted validation fails.
 */
export function getConversation(
  database: DatabaseSync,
  conversationId: string
): Conversation | undefined {
  const metadata = getConversationMetadata(database, conversationId)
  if (!metadata) return undefined
  const rows = database
    .prepare(
      `SELECT id, role, model, content, status,
    finish_reason AS finishReason, created_at AS createdAt, updated_at AS updatedAt
    FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id`
    )
    .all(conversationId)
  return { ...metadata, messages: rows.map(parseConversationMessage) }
}
