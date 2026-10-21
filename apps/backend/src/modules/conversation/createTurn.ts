import { v7 as uuidv7 } from "uuid"
import {
  conversationMetadataSchema,
  conversationUserMessageSchema,
  conversationAssistantMessageSchema,
  type Conversation,
  type ConversationUserMessage
} from "@lys/share"
import type {
  ConversationTurn,
  ConversationTurnTarget,
  ConversationTurnUserMessage,
  CreateConversationTurnOptions
} from "../chat/persistence"
import { ConversationNotFoundError } from "../../utils/errors"
import type { ConversationTurnTransaction } from "./records"

/**
 * Creates a new empty, untitled conversation answered by one agent.
 * @param transaction - Conversation creation lent by the turn's write
 * transaction.
 * @param target - Identity of the new conversation and the code of the agent
 * that answers it.
 * @param now - Creation time, also its initial activity time.
 * @returns The newly stored independent conversation snapshot.
 * @throws If validation fails, the transaction has ended, or the write fails.
 */
function createConversation(
  transaction: Pick<ConversationTurnTransaction, "createConversation">,
  target: Extract<ConversationTurnTarget, { kind: "new" }>,
  now: string
): Conversation {
  const metadata = conversationMetadataSchema.parse({
    id: target.id,
    title: null,
    agentCode: target.agentCode,
    createdAt: now,
    updatedAt: now
  })
  transaction.createConversation(metadata)
  return { ...metadata, messages: [], sources: [] }
}

/**
 * Calculates the number the next attachment of a conversation gets.
 * @param conversation - Snapshot of the conversation before the turn.
 * @returns One more than the highest number its attachments have; 1 when it
 * has none.
 */
function calculateNextAttachmentNumber(conversation: Conversation): number {
  let highestNumber = 0
  for (const message of conversation.messages) {
    if (message.role !== "user") continue
    for (const attachment of message.attachments)
      highestNumber = Math.max(highestNumber, attachment.number)
  }
  return highestNumber + 1
}

/**
 * Builds the validated user message of a turn with provisional attachment
 * numbers.
 * @param userMessage - Identity, content, and attachment drafts.
 * @param now - Time of the turn.
 * @returns The message with its attachments numbered from 1 in message
 * order, for {@link buildNumberedUserMessage} once the conversation's highest
 * number is known.
 * @throws If the message or an attachment violates the conversation contract.
 */
function buildUserMessage(
  userMessage: ConversationTurnUserMessage,
  now: string
): ConversationUserMessage {
  return conversationUserMessageSchema.parse({
    id: userMessage.id,
    role: "user",
    content: userMessage.content,
    attachments: userMessage.attachments.map((draft, index) => ({
      ...draft,
      number: index + 1
    })),
    createdAt: now
  })
}

/**
 * Builds a validated message with its attachments numbered after the
 * conversation's.
 * @param userMessage - Validated message whose attachments are numbered
 * from 1.
 * @param conversation - Snapshot of the conversation before the turn.
 * @returns The message with each attachment's number raised by the
 * conversation's highest attachment number, so the message continues the
 * conversation's numbering in message order; the message itself when it has
 * no attachments.
 */
function buildNumberedUserMessage(
  userMessage: ConversationUserMessage,
  conversation: Conversation
): ConversationUserMessage {
  if (userMessage.attachments.length === 0) return userMessage
  const offset = calculateNextAttachmentNumber(conversation) - 1
  return {
    ...userMessage,
    attachments: userMessage.attachments.map((attachment) => ({
      ...attachment,
      number: attachment.number + offset
    }))
  }
}

/**
 * Stores a validated user/assistant pair inside the caller-owned transaction.
 * @param transaction - Records lent to the caller's write transaction.
 * @param options - Conversation selection, the user message with its
 * identity and attachment drafts, and the model. A new conversation stores
 * the identity and the agent code it names; an existing conversation keeps
 * its agent.
 * @param now - Time of the turn, read once by the caller. Every value the turn
 * builds carries it: a new conversation's times, both messages' times, and
 * the update time of each reply the turn interrupts.
 * @returns The conversation snapshot and both messages written to the
 * transaction; the user message carries its attachments, numbered after the
 * conversation's highest attachment number in message order.
 * @throws ConversationNotFoundError if the continued conversation is not
 * stored.
 * @throws If validation fails, the transaction has ended, a stored value
 * violates the conversation contract, or storage rejects a write.
 * @remarks Both messages are validated before the first write; the user
 * message's attachments get their final numbers once the snapshot is read.
 * A reply still streaming in an existing conversation becomes interrupted
 * before the snapshot is read, so the new turn supersedes it. A stopped
 * request can finalize its reply after the client has already sent the next
 * turn. Interrupting it here keeps its stored text and answered calls in the
 * new turn's context, and the streaming-only write guards then reject every
 * later write from the superseded generation.
 */
export function createConversationTurn(
  transaction: ConversationTurnTransaction,
  options: CreateConversationTurnOptions,
  now: string
): ConversationTurn {
  const draftUserMessage = buildUserMessage(options.userMessage, now)
  const assistantMessage = conversationAssistantMessageSchema.parse({
    id: uuidv7(),
    role: "assistant",
    model: options.model,
    parts: [],
    status: "streaming",
    finishReason: null,
    createdAt: now,
    updatedAt: now
  })
  const target = options.conversation
  if (target.kind === "existing")
    transaction.updateStreamingAssistantMessagesToInterrupted(target.id, now)
  const conversation =
    target.kind === "new"
      ? createConversation(transaction, target, now)
      : transaction.findConversation(target.id)
  if (conversation === undefined) throw new ConversationNotFoundError()
  const userMessage = buildNumberedUserMessage(draftUserMessage, conversation)
  transaction.createUserMessage(conversation.id, userMessage)
  transaction.createAssistantMessage(conversation.id, assistantMessage)
  return {
    conversation,
    userMessage,
    assistantMessage,
    isNewConversation: target.kind === "new"
  }
}
