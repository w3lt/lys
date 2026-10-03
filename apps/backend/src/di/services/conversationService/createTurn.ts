import { v7 as uuidv7 } from "uuid"
import {
  conversationMetadataSchema,
  conversationUserMessageSchema,
  conversationAssistantMessageSchema,
  type Conversation
} from "@lys/share"
import type {
  ConversationTurn,
  CreateConversationTurnOptions
} from "../../../modules/chat/chat/persistence"
import { ConversationNotFoundError } from "../../../utils/errors"
import type { ConversationTurnTransaction } from "./records"

/**
 * Creates a new empty, untitled conversation using the supplied system
 * instruction.
 * @param transaction - Records lent to the turn's write transaction.
 * @param systemPrompt - Default prompt loaded by the turn creator.
 * @param now - Creation time, also its initial activity time.
 * @returns The newly stored independent conversation snapshot.
 * @throws If validation or storage fails.
 */
function createConversation(
  transaction: ConversationTurnTransaction,
  systemPrompt: string,
  now: string
): Conversation {
  const metadata = conversationMetadataSchema.parse({
    id: uuidv7(),
    title: null,
    systemPrompt,
    createdAt: now,
    updatedAt: now
  })
  transaction.createConversation(metadata)
  return { ...metadata, messages: [] }
}

/**
 * Selects the conversation a turn continues, after interrupting the reply it
 * supersedes.
 * @param transaction - Records lent to the turn's write transaction.
 * @param conversationId - Conversation receiving the turn.
 * @param now - Time stored on each interrupted reply.
 * @returns The conversation snapshot, including the interruption.
 * @throws ConversationNotFoundError if the conversation is not stored.
 * @remarks A stopped request can finalize its reply after the client has already
 * sent the next turn. Interrupting it here keeps its partial text in the new
 * turn's context, and the streaming-only write guards then reject every later
 * write from the superseded generation.
 */
function findContinuedConversation(
  transaction: ConversationTurnTransaction,
  conversationId: string,
  now: string
): Conversation {
  transaction.updateStreamingAssistantMessagesToInterrupted(conversationId, now)
  const conversation = transaction.findConversation(conversationId)
  if (!conversation) throw new ConversationNotFoundError()
  return conversation
}

/**
 * Stores a validated user/assistant pair inside the caller-owned transaction.
 * @param transaction - Records lent to the caller's write transaction.
 * @param options - Conversation selection and authored content. Its
 * `systemPrompt` is not read; the `systemPrompt` argument is the prompt stored.
 * @param systemPrompt - Instruction persisted only with a conversation this turn
 * creates; an existing conversation keeps its stored prompt.
 * @returns The conversation snapshot and both messages written to the transaction.
 * @throws If the conversation is missing, validation fails, or storage rejects a write.
 * @remarks Every value the turn stores carries one timestamp, read when the
 * turn starts. A reply still streaming in an existing conversation becomes
 * interrupted before the snapshot is read, so the new turn supersedes it.
 */
export function createConversationTurn(
  transaction: ConversationTurnTransaction,
  options: CreateConversationTurnOptions,
  systemPrompt: string
): ConversationTurn {
  const now = new Date().toISOString()
  const conversation =
    options.conversationId === undefined
      ? createConversation(transaction, systemPrompt, now)
      : findContinuedConversation(transaction, options.conversationId, now)
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
  transaction.createUserMessage(conversation.id, userMessage)
  transaction.createAssistantMessage(conversation.id, assistantMessage)
  return {
    conversation,
    userMessage,
    assistantMessage,
    isNewConversation: options.conversationId === undefined
  }
}
