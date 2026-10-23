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
import type { AttachmentFileStatus } from "../attachment/attachmentFileStore"
import type {
  ContextToolCall,
  ReplyContextImage,
  ReplyContextImageSides,
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

/**
 * Finds whether the file of one image attachment of a conversation is
 * stored, without reading it.
 *
 * @param messageId - UUIDv7 of the user message the image was sent with.
 * @param attachment - The stored image attachment.
 * @returns A promise resolving to `stored` when its file is on this machine,
 * or to `missing` when it is not.
 * @throws If the file's path cannot be examined for another reason.
 */
export type GetAttachmentImageFileStatus = (
  messageId: string,
  attachment: ConversationImageAttachment
) => Promise<AttachmentFileStatus>

/**
 * The images a context sends, by attachment number.
 *
 * @typeParam TImage - What the context holds of each image: the whole image
 * for a turn, its sides for a measurement.
 */
export type AgentContextImages<
  TImage extends ReplyContextImageSides = ReplyContextImage
> =
  | Readonly<{
      /** The model cannot see images; each becomes a sentence saying so. */
      status: "unseen"
    }>
  | Readonly<{
      /** The model sees images; each found image follows its message's text. */
      status: "seen"
      /**
       * Each image whose file was found, by attachment number; an image
       * absent here becomes a sentence saying its file is missing.
       */
      images: ReadonlyMap<number, TImage>
    }>

/** The message a turn answers, as the context needs it. */
export type AgentContextUserMessage = Pick<
  ConversationUserMessage,
  "content" | "attachments"
>

/**
 * Context images of a model without vision: no file is read, and each image
 * becomes a sentence saying the model cannot see it.
 */
export const UNSEEN_CONTEXT_IMAGES: AgentContextImages<never> = Object.freeze({
  status: "unseen"
})

/**
 * A context message one stored reply becomes: a round of the agent's, or
 * the result of one of its calls.
 */
type ReplyRoundContextMessage = Extract<
  ReplyContextMessage,
  { role: "assistant" | "tool" }
>

/**
 * What the context an agent sends to its model for one turn is built from.
 *
 * @typeParam TImage - What the context holds of each image the model sees.
 */
export type AgentContextSource<
  TImage extends ReplyContextImageSides = ReplyContextImage
> = Readonly<{
  /** The agent's own instructions, sent first. */
  systemPrompt: string
  /** Stored transcript before the turn, in conversation order. */
  history: readonly ConversationMessage[]
  /** Text and attachments of the message the turn answers, sent last. */
  userMessage: AgentContextUserMessage
  /**
   * The images the context sends: {@link UNSEEN_CONTEXT_IMAGES} for a model
   * without vision, otherwise as {@link readAgentContextImages} read them for
   * the history and the new message, or as
   * {@link getAgentContextImageSides} found them for a measurement.
   */
  images: AgentContextImages<TImage>
}>

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
): readonly ReplyRoundContextMessage[] {
  const text = parts
    .flatMap((part) => (part.kind === "text" ? [part.content] : []))
    .join("")
  const answeredCalls = parts.filter(isAnsweredToolCallPart)
  if (text === "" && answeredCalls.length === 0) return []
  const assistantMessage: ReplyRoundContextMessage = {
    role: "assistant",
    content: text,
    toolCalls: answeredCalls.map(buildContextToolCall)
  }
  const resultMessages = answeredCalls.map(
    (part): ReplyRoundContextMessage => ({
      role: "tool",
      toolCallId: part.id,
      content: part.result
    })
  )
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
): readonly ReplyRoundContextMessage[] {
  if (!isContextReply(message)) return []
  return buildReplyPartRounds(message.parts).flatMap(
    buildStoredRoundContextMessages
  )
}

/**
 * Builds the context form of one user message.
 * @typeParam TImage - What the context holds of each image the model sees.
 * @param message - The message's text and attachments.
 * @param images - The images the context sends.
 * @returns The person's text with the message's attachment list, as
 * {@link buildUserMessageText} builds it, and the message's images the model
 * sees in attachment order. An image the model does not see, because the
 * model cannot see images or the image's file is missing, is a placeholder
 * sentence in the text instead.
 */
function buildUserContextMessage<TImage extends ReplyContextImageSides>(
  message: AgentContextUserMessage,
  images: AgentContextImages<TImage>
): ReplyContextMessage<TImage> {
  const contextImages: TImage[] = []
  const placeholders: string[] = []
  for (const attachment of message.attachments) {
    if (attachment.kind !== "image") continue
    const image =
      images.status === "seen"
        ? images.images.get(attachment.number)
        : undefined
    if (images.status === "unseen")
      placeholders.push(formatUnseenImagePlaceholder(attachment))
    else if (image === undefined)
      placeholders.push(formatMissingImagePlaceholder(attachment))
    else contextImages.push(image)
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
 * @typeParam TImage - What the context holds of each image the model sees.
 * @param message - Stored user message or reply.
 * @param images - The images the context sends.
 * @returns The user message as {@link buildUserContextMessage} builds it; a
 * reply's messages as {@link buildStoredReplyContextMessages} builds them.
 */
function buildStoredContextMessages<TImage extends ReplyContextImageSides>(
  message: ConversationMessage,
  images: AgentContextImages<TImage>
): readonly ReplyContextMessage<TImage>[] {
  if (message.role === "user") return [buildUserContextMessage(message, images)]
  return buildStoredReplyContextMessages(message)
}

/**
 * Builds the sides of one image the model sees, as a measurement counts it.
 * @param attachment - Stored image attachment.
 * @returns The image's width and height.
 */
function buildContextImageSides(
  attachment: ConversationImageAttachment
): ReplyContextImageSides {
  return { width: attachment.width, height: attachment.height }
}

/**
 * Reads the images a turn's context sends to a model that sees images.
 * @param messages - Stored messages the context is built from, in
 * conversation order, the turn's own user message last.
 * @param findAttachmentImage - Reads one image's bytes; borrowed until the
 * returned promise settles.
 * @returns A promise resolving to `seen` with each image attachment whose
 * file was found, with its media type, sides, and bytes, by attachment
 * number. The files are read together, requested in conversation order. A
 * caller whose model cannot see images uses {@link UNSEEN_CONTEXT_IMAGES}
 * instead of calling this, so no file is read.
 * @throws The reader's failure, for a file that cannot be read although it
 * is not missing.
 */
export async function readAgentContextImages(
  messages: readonly ConversationMessage[],
  findAttachmentImage: FindAttachmentImage
): Promise<AgentContextImages> {
  return await getSeenContextImages(messages, async (messageId, attachment) => {
    const data = await findAttachmentImage(messageId, attachment)
    return data === undefined ? undefined : buildContextImage(attachment, data)
  })
}

/**
 * Finds the images a measured context counts for a model that sees images,
 * without reading their files.
 * @param messages - Stored messages the context is built from, in
 * conversation order.
 * @param getAttachmentImageFileStatus - Finds whether one image's file is
 * stored; borrowed until the returned promise settles.
 * @returns A promise resolving to `seen` with the sides of each image
 * attachment whose file is stored, by attachment number: the images, and
 * the missing-file placeholders, that {@link readAgentContextImages} would
 * give a turn. The files are looked up together, in conversation order. A
 * caller whose model cannot see images uses {@link UNSEEN_CONTEXT_IMAGES}
 * instead of calling this, so no file is looked up.
 * @throws The lookup's failure, for a path that cannot be examined although
 * it is not missing.
 */
export async function getAgentContextImageSides(
  messages: readonly ConversationMessage[],
  getAttachmentImageFileStatus: GetAttachmentImageFileStatus
): Promise<AgentContextImages<ReplyContextImageSides>> {
  return await getSeenContextImages(messages, async (messageId, attachment) =>
    (await getAttachmentImageFileStatus(messageId, attachment)) === "stored"
      ? buildContextImageSides(attachment)
      : undefined
  )
}

/**
 * Gets the images a context sends to a model that sees images.
 * @typeParam TImage - What the context holds of each image.
 * @param messages - Stored messages, in conversation order.
 * @param findImage - Finds what the context holds of one image, or
 * undefined when its file is missing; borrowed until the returned promise
 * settles.
 * @returns A promise resolving to `seen` with each image found, by
 * attachment number. Every image is requested at once, in conversation
 * order.
 * @throws The first failure of `findImage`.
 */
async function getSeenContextImages<TImage extends ReplyContextImageSides>(
  messages: readonly ConversationMessage[],
  findImage: (
    messageId: string,
    attachment: ConversationImageAttachment
  ) => Promise<TImage | undefined>
): Promise<AgentContextImages<TImage>> {
  const found = await Promise.all(
    listImageAttachments(messages).map(
      async ({ messageId, attachment }) =>
        [attachment.number, await findImage(messageId, attachment)] as const
    )
  )
  const images = new Map<number, TImage>()
  for (const [number, image] of found)
    if (image !== undefined) images.set(number, image)
  return Object.freeze({ status: "seen", images })
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
 * Formats the system prompt a context sends.
 * @param systemPrompt - The agent's own instructions.
 * @param switchedOffToolNames - Names of the tools the person switched off,
 * each once; empty when none is.
 * @returns The instructions unchanged when no tool is switched off;
 * otherwise the instructions followed, after a blank line, by a note naming
 * the switched-off tools in request order and telling the model to say a
 * needed one is off instead of guessing what it would return.
 */
export function formatSystemPrompt(
  systemPrompt: string,
  switchedOffToolNames: readonly string[]
): string {
  if (switchedOffToolNames.length === 0) return systemPrompt
  const toolNames = switchedOffToolNames.join(", ")
  return `${systemPrompt}\n\nThese tools are turned off in Settings → Tools, so you cannot call them now: ${toolNames}. If a request needs one of them, say that it is turned off and can be turned on in Settings → Tools; do not guess what it would return or claim to have used it.`
}

/**
 * Builds the context an agent sends to its model for one turn.
 * @typeParam TImage - What the context holds of each image the model sees:
 * the whole image for a turn, its sides for a measurement.
 * @param source - The system prompt, the history, the new message, and the
 * images the context sends.
 * @returns The system prompt, then the history's user messages and the rounds
 * of its completed and interrupted replies in order, then the new message
 * once. Each user message sends its text, the list of its attachments when it
 * has any, and its images the model sees, with a placeholder sentence for
 * each image it does not see. Each stored round sends its text and the tool
 * calls that have a result, followed by those results; reasoning, calls
 * without a result, and rounds with neither text nor such a call are left
 * out, and failed and streaming replies are left out whole.
 */
export function buildAgentContext<TImage extends ReplyContextImageSides>(
  source: AgentContextSource<TImage>
): readonly ReplyContextMessage<TImage>[] {
  const { images } = source
  return [
    { role: "system", content: source.systemPrompt },
    ...source.history.flatMap((message) =>
      buildStoredContextMessages(message, images)
    ),
    buildUserContextMessage(source.userMessage, images)
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
