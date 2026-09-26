import type { DatabaseSync } from "node:sqlite"
import { v7 as uuidv7 } from "uuid"
import {
  conversationMetadataSchema,
  conversationUserMessageSchema,
  conversationAssistantMessageSchema,
  type Conversation
} from "@lys/share"
import { getConversation } from "./readConversation"
import type { ConversationTurn, CreateConversationTurnOptions } from "./share"
import { ConversationNotFoundError } from "../../../utils/errors"

/**
 * Creates metadata for a new empty conversation using the supplied system instruction.
 * @param database - Borrowed connection inside the turn transaction.
 * @param systemPrompt - Default prompt loaded by the turn creator.
 * @returns The newly inserted independent conversation snapshot.
 * @throws If validation or insertion fails.
 */
function createConversation(
  database: DatabaseSync,
  systemPrompt: string
): Conversation {
  const now = new Date().toISOString()
  const metadata = conversationMetadataSchema.parse({
    id: uuidv7(),
    title: null,
    systemPrompt,
    createdAt: now,
    updatedAt: now
  })
  database
    .prepare(
      `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?)`
    )
    .run(metadata.id, metadata.systemPrompt, now, now)
  return { ...metadata, messages: [] }
}

/**
 * Interrupts replies still streaming in a conversation that a new turn supersedes.
 * @param database - Borrowed connection inside the turn transaction.
 * @param conversationId - Conversation receiving the turn; a missing one changes nothing.
 * @remarks A stopped request can finalize its reply after the client has already
 * sent the next turn. Interrupting it here keeps its partial text in the new
 * turn's context, and the streaming-only write guards then reject every later
 * write from the superseded generation.
 */
function updateSupersededAssistantMessages(
  database: DatabaseSync,
  conversationId: string
): void {
  const updatedAt = new Date().toISOString()
  database
    .prepare(
      `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
    WHERE conversation_id = ? AND role = 'assistant' AND status = 'streaming'`
    )
    .run(updatedAt, conversationId)
}

/**
 * Inserts a validated user/assistant pair inside the caller-owned transaction.
 * @param database - Borrowed connection with an active write transaction.
 * @param options - Conversation selection and authored content.
 * @param systemPrompt - Default instruction used only for a new conversation.
 * @returns The conversation snapshot and both committed-to-transaction messages.
 * @throws If the conversation is missing, validation fails, or SQLite rejects a write.
 * @remarks A reply still streaming in an existing conversation becomes
 * interrupted before the snapshot is read, so the new turn supersedes it.
 */
export function createConversationTurn(
  database: DatabaseSync,
  options: CreateConversationTurnOptions,
  systemPrompt: string
): ConversationTurn {
  if (options.conversationId !== undefined)
    updateSupersededAssistantMessages(database, options.conversationId)
  const conversation =
    options.conversationId === undefined
      ? createConversation(database, systemPrompt)
      : getConversation(database, options.conversationId)
  if (!conversation) throw new ConversationNotFoundError()
  const now = new Date().toISOString()
  const userMessage = conversationUserMessageSchema.parse({
    id: uuidv7(),
    role: "user",
    content: options.userMessageContent,
    createdAt: now
  })
  const assistantMessage = conversationAssistantMessageSchema.parse({
    id: uuidv7(),
    role: "assistant",
    model: options.model,
    content: "",
    status: "streaming",
    finishReason: null,
    createdAt: now,
    updatedAt: now
  })
  database
    .prepare(
      `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, 'user', ?, ?)`
    )
    .run(userMessage.id, conversation.id, userMessage.content, now)
  database
    .prepare(
      `INSERT INTO conversation_messages
    (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
    VALUES (?, ?, 'assistant', ?, '', 'streaming', NULL, ?, ?)`
    )
    .run(assistantMessage.id, conversation.id, assistantMessage.model, now, now)
  return {
    conversation,
    userMessage,
    assistantMessage,
    isNewConversation: options.conversationId === undefined
  }
}
