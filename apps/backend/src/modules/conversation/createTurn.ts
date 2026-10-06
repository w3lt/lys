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
} from "../chat/persistence"
import { ConversationNotFoundError } from "../../utils/errors"
import type { ConversationTurnTransaction } from "./records"

/**
 * Creates a new empty, untitled conversation using the supplied system
 * instruction.
 * @param transaction - Conversation creation lent by the turn's write
 * transaction.
 * @param systemPrompt - Prompt stored with the conversation.
 * @param now - Creation time, also its initial activity time.
 * @returns The newly stored independent conversation snapshot.
 * @throws If validation fails, the transaction has ended, or the write fails.
 */
function createConversation(
  transaction: Pick<ConversationTurnTransaction, "createConversation">,
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
 * Stores a validated user/assistant pair inside the caller-owned transaction.
 * @param transaction - Records lent to the caller's write transaction.
 * @param options - Conversation selection and authored content. Its
 * `systemPrompt` is stored only with a conversation this turn creates; an
 * existing conversation keeps its stored prompt.
 * @param now - Time of the turn, read once by the caller. Every value the turn
 * builds carries it: a new conversation's times, both messages' times, and
 * the update time of each reply the turn interrupts.
 * @returns The conversation snapshot and both messages written to the transaction.
 * @throws ConversationNotFoundError if the continued conversation is not
 * stored.
 * @throws If validation fails, the transaction has ended, a stored value
 * violates the conversation contract, or storage rejects a write.
 * @remarks Both messages are validated before the first write. A reply still
 * streaming in an existing conversation becomes interrupted before the
 * snapshot is read, so the new turn supersedes it. A stopped request can
 * finalize its reply after the client has already sent the next turn.
 * Interrupting it here keeps its partial text in the new turn's context, and
 * the streaming-only write guards then reject every later write from the
 * superseded generation.
 */
export function createConversationTurn(
  transaction: ConversationTurnTransaction,
  options: CreateConversationTurnOptions,
  now: string
): ConversationTurn {
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
  if (options.conversationId !== undefined)
    transaction.updateStreamingAssistantMessagesToInterrupted(
      options.conversationId,
      now
    )
  const conversation =
    options.conversationId === undefined
      ? createConversation(transaction, options.systemPrompt, now)
      : transaction.findConversation(options.conversationId)
  if (conversation === undefined) throw new ConversationNotFoundError()
  transaction.createUserMessage(conversation.id, userMessage)
  transaction.createAssistantMessage(conversation.id, assistantMessage)
  return {
    conversation,
    userMessage,
    assistantMessage,
    isNewConversation: options.conversationId === undefined
  }
}
