import {
  isAnsweredToolCall,
  type AnsweredToolCallReplyPart,
  type ConversationAssistantMessage,
  type ConversationImageAttachment,
  type ConversationMessage,
  type ConversationUserMessage,
  type ReplyPart
} from "@lys/share"
import {
  buildUserMessageText,
  formatMissingImagePlaceholder,
  formatUnseenImagePlaceholder
} from "../attachment/attachmentContext"
import type {
  ContextToolCall,
  ReplyContextImage,
  ReplyContextMessage
} from "./replyModel"

/**
 * Reads the stored bytes of one image attachment of a conversation.
 *
 * @param messageId - UUIDv7 of the user message the image was sent with.
 * @param attachment - The stored image attachment.
 * @returns A promise resolving to the image's bytes as stored, or to
 * undefined when its file is missing from this machine.
 * @throws If the file cannot be read for another reason.
 */
export type FindAttachmentImage = (
  messageId: string,
  attachment: ConversationImageAttachment
) => Promise<Uint8Array | undefined>

/** The images a context sends, by attachment number. */
export type AgentContextImages =
  | Readonly<{
      /** The model cannot see images; each becomes a sentence saying so. */
      status: "unseen"
    }>
  | Readonly<{
      /** The model sees images; each read image follows its message's text. */
      status: "loaded"
      /**
       * Bytes of each image whose file was read, by attachment number; an
       * image absent here becomes a sentence saying its file is missing.
       */
      images: ReadonlyMap<number, Uint8Array>
    }>

/** The message a turn answers, as the context needs it. */
export type AgentContextUserMessage = Pick<
  ConversationUserMessage,
  "content" | "attachments"
>

/** Context images of a model without vision. */
const UNSEEN_CONTEXT_IMAGES = Object.freeze({
  status: "unseen"
} satisfies AgentContextImages)

/**
 * Selects stored replies that can supply conversation context.
 * @param message - One persisted stored reply.
 * @returns True for completed and interrupted replies; failed and streaming
 * replies are left out.
 */
function isContextReply(message: ConversationAssistantMessage): boolean {
  return message.status === "completed" || message.status === "interrupted"
}

/**
 * Answers whether a stored part is a tool call with a result.
 * @param part - One part of a stored reply.
 * @returns True for a tool call that {@link isAnsweredToolCall} answers true
 * for: one that succeeded, failed, or was rejected.
 */
function isAnsweredToolCallPart(
  part: ReplyPart
): part is AnsweredToolCallReplyPart {
  return part.kind === "tool-call" && isAnsweredToolCall(part)
}

/**
 * Groups a stored reply's parts by the round they belong to.
 * @param parts - Parts in stored order, whose rounds never decrease.
 * @returns Each round's parts in stored order, rounds in order.
 */
function buildReplyPartRounds(
  parts: readonly ReplyPart[]
): readonly (readonly ReplyPart[])[] {
  const rounds: ReplyPart[][] = []
  for (const part of parts) {
    const lastRound = rounds.at(-1)
    if (lastRound?.[0]?.round === part.round) lastRound.push(part)
    else rounds.push([part])
  }
  return rounds
}

/**
 * Builds the context form of a stored call.
 * @param part - Stored call with a result.
 * @returns The call with its identity, name, and the model's argument text.
 */
function buildContextToolCall(
  part: AnsweredToolCallReplyPart
): ContextToolCall {
  return {
    id: part.id,
    toolName: part.toolName,
    argumentText: part.argumentText
  }
}

/**
 * Builds the context messages of one stored round.
 * @param parts - The round's parts in stored order.
 * @returns One assistant message with the round's text and its answered
 * calls, then one result message per answered call; none when the round has
 * neither text nor an answered call. Reasoning and calls without a result
 * are left out.
 */
function buildStoredRoundContextMessages(
  parts: readonly ReplyPart[]
): readonly ReplyContextMessage[] {
  const text = parts
    .flatMap((part) => (part.kind === "text" ? [part.content] : []))
    .join("")
  const answeredCalls = parts.filter(isAnsweredToolCallPart)
  if (text === "" && answeredCalls.length === 0) return []
  const assistantMessage: ReplyContextMessage = {
    role: "assistant",
    content: text,
    toolCalls: answeredCalls.map(buildContextToolCall)
  }
  const resultMessages = answeredCalls.map((part): ReplyContextMessage => ({
    role: "tool",
    toolCallId: part.id,
    content: part.result
  }))
  return [assistantMessage, ...resultMessages]
}

/**
 * Builds the context messages of one stored reply.
 * @param message - Stored reply.
 * @returns A context reply's rounds as {@link buildStoredRoundContextMessages}
 * builds them; nothing for another reply.
 */
function buildStoredReplyContextMessages(
  message: ConversationAssistantMessage
): readonly ReplyContextMessage[] {
  if (!isContextReply(message)) return []
  return buildReplyPartRounds(message.parts).flatMap(
    buildStoredRoundContextMessages
  )
}

/**
 * Builds the context form of one user message.
 * @param message - The message's text and attachments.
 * @param images - The images the context sends.
 * @returns The person's text with the message's attachment list, as
 * {@link buildUserMessageText} builds it, and the message's images the model
 * sees in attachment order. An image the model does not see, because the
 * model cannot see images or the image's file is missing, is a placeholder
 * sentence in the text instead.
 */
function buildUserContextMessage(
  message: AgentContextUserMessage,
  images: AgentContextImages
): ReplyContextMessage {
  const contextImages: ReplyContextImage[] = []
  const placeholders: string[] = []
  for (const attachment of message.attachments) {
    if (attachment.kind !== "image") continue
    const data =
      images.status === "loaded"
        ? images.images.get(attachment.number)
        : undefined
    if (images.status === "unseen")
      placeholders.push(formatUnseenImagePlaceholder(attachment))
    else if (data === undefined)
      placeholders.push(formatMissingImagePlaceholder(attachment))
    else contextImages.push(buildContextImage(attachment, data))
  }
  return {
    role: "user",
    content: buildUserMessageText(
      message.content,
      message.attachments,
      placeholders
    ),
    images: contextImages
  }
}

/**
 * Builds the context form of one image the model sees.
 * @param attachment - Stored image attachment.
 * @param data - The image's bytes as stored.
 * @returns The image with its media type, sides, and bytes.
 */
function buildContextImage(
  attachment: ConversationImageAttachment,
  data: Uint8Array
): ReplyContextImage {
  return {
    mediaType: attachment.mediaType,
    width: attachment.width,
    height: attachment.height,
    data
  }
}

/**
 * Builds the context messages of one stored message.
 * @param message - Stored user message or reply.
 * @param images - The images the context sends.
 * @returns The user message as {@link buildUserContextMessage} builds it; a
 * reply's messages as {@link buildStoredReplyContextMessages} builds them.
 */
function buildStoredContextMessages(
  message: ConversationMessage,
  images: AgentContextImages
): readonly ReplyContextMessage[] {
  if (message.role === "user") return [buildUserContextMessage(message, images)]
  return buildStoredReplyContextMessages(message)
}

/**
 * Loads the images a turn's context sends.
 * @param messages - Stored messages the context is built from, in
 * conversation order, the turn's own user message last.
 * @param canSeeImages - Whether the model sees images.
 * @param findAttachmentImage - Reads one image's bytes; borrowed until the
 * returned promise settles.
 * @returns A promise resolving to `unseen` when the model cannot see images,
 * without reading any file; otherwise to `loaded` with the bytes of each
 * image attachment whose file was found, by attachment number. The files are
 * read together, requested in conversation order.
 * @throws The reader's failure, for a file that cannot be read although it
 * is not missing.
 */
export async function loadAgentContextImages(
  messages: readonly ConversationMessage[],
  canSeeImages: boolean,
  findAttachmentImage: FindAttachmentImage
): Promise<AgentContextImages> {
  if (!canSeeImages) return UNSEEN_CONTEXT_IMAGES
  const loaded = await Promise.all(
    listImageAttachments(messages).map(
      async ({ messageId, attachment }) =>
        [
          attachment.number,
          await findAttachmentImage(messageId, attachment)
        ] as const
    )
  )
  const images = new Map<number, Uint8Array>()
  for (const [number, data] of loaded)
    if (data !== undefined) images.set(number, data)
  return Object.freeze({ status: "loaded", images })
}

/**
 * Lists the image attachments of a transcript's user messages.
 * @param messages - Stored messages and the new message, in conversation
 * order.
 * @returns Each image attachment with its message's identity, in
 * conversation order; replies have no attachments.
 */
function listImageAttachments(
  messages: readonly ConversationMessage[]
): readonly Readonly<{
  messageId: string
  attachment: ConversationImageAttachment
}>[] {
  return messages.flatMap((message) =>
    message.role === "user"
      ? message.attachments
          .filter((attachment) => attachment.kind === "image")
          .map((attachment) => ({ messageId: message.id, attachment }))
      : []
  )
}

/**
 * Builds the context an agent sends to its model for one turn.
 * @param systemPrompt - The agent's own instructions, sent first.
 * @param history - Stored transcript before the turn, in conversation order.
 * @param userMessage - Text and attachments of the message the turn answers,
 * sent last.
 * @param images - The images the context sends, as
 * {@link loadAgentContextImages} loaded them for the history and the new
 * message.
 * @returns The system prompt, then the history's user messages and the rounds
 * of its completed and interrupted replies in order, then the new message
 * once. Each user message sends its text, the list of its attachments when it
 * has any, and its images the model sees, with a placeholder sentence for
 * each image it does not see. Each stored round sends its text and the tool
 * calls that have a result, followed by those results; reasoning, calls
 * without a result, and rounds with neither text nor such a call are left
 * out, and failed and streaming replies are left out whole.
 */
export function buildAgentContext(
  systemPrompt: string,
  history: readonly ConversationMessage[],
  userMessage: AgentContextUserMessage,
  images: AgentContextImages
): readonly ReplyContextMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...history.flatMap((message) =>
      buildStoredContextMessages(message, images)
    ),
    buildUserContextMessage(userMessage, images)
  ]
}

/**
 * Counts the stored messages a turn's context includes.
 * @param history - Stored transcript before the turn, in conversation order.
 * @returns How many of its messages {@link buildAgentContext} sends: every
 * user message, and each completed or interrupted reply with a round that
 * sends text or a tool call with a result. A reply counts once, however many
 * context messages its rounds and tool results become.
 */
export function calculateAgentContextHistoryMessageCount(
  history: readonly ConversationMessage[]
): number {
  return history.filter(
    (message) =>
      message.role === "user" ||
      buildStoredReplyContextMessages(message).length > 0
  ).length
}
