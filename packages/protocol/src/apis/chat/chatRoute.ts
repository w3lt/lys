import { apiChatRoute } from "../llm"
import * as z from "zod"
import {
  agentCodeSchema,
  attachmentNameSchema,
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationUserMessageSchema,
  hasDistinctAttachmentNames,
  hasDistinctToolNames,
  isEveryToolRunBy,
  MAXIMUM_ATTACHMENT_BYTES,
  MAXIMUM_MESSAGE_ATTACHMENT_BYTES,
  MAXIMUM_MESSAGE_ATTACHMENT_COUNT,
  READ_ATTACHMENT_TOOL_NAME,
  toolDefinitionSchema,
  toolNameSchema,
  type ToolDefinition
} from "@lys/share"
import { agentNotFoundProblemSchema } from "../../http/errors/agent"
import {
  chatAttachmentUnsupportedProblemSchema,
  chatBackendToolUnavailableProblemSchema,
  chatImageNeedsVisionProblemSchema
} from "../../http/errors/chat"
import {
  conversationAgentMissingProblemSchema,
  conversationNotFoundProblemSchema
} from "../../http/errors/conversation"
import { llmRuntimeUnavailableProblemSchema } from "../../http/errors/llm"
import { llmServiceBusyProblemSchema } from "../../http/errors/llmServiceBusy"
import {
  chatReplyPartDeltaEventSchema,
  chatReplyPartEventSchema,
  chatSourcesEventSchema,
  chatDoneEventSchema,
  chatErrorEventSchema,
  chatInterruptedEventSchema,
  chatTitleEventSchema,
  chatToolApprovalEventSchema,
  chatToolCallEventSchema
} from "./_share"

/** Inclusive maximum sampling temperature accepted by chat requests and their UI. */
export const MAXIMUM_GENERATION_TEMPERATURE = 1

/** Bytes in one mebibyte. */
const BYTES_PER_MEBIBYTE = 1024 * 1024

/**
 * Largest chat request body, in bytes, that the chat endpoint accepts.
 *
 * @remarks Holds a message with `MAXIMUM_MESSAGE_ATTACHMENT_BYTES` of
 * attachments: base64 makes content a third longer, and the JSON around it
 * is small. The backend enforces it as the route's body limit and answers a
 * larger body with `413`; every other route keeps its own limit.
 */
export const MAXIMUM_CHAT_BODY_BYTES = 32 * BYTES_PER_MEBIBYTE

/** Base64 characters that encode three bytes. */
const BASE64_GROUP_LENGTH = 4

/** Bytes three base64 characters stand for, when the group has no padding. */
const BASE64_GROUP_BYTES = 3

/**
 * Counts the bytes a padded base64 text decodes to, without decoding it.
 *
 * @param content - Valid padded base64 text.
 * @returns Three bytes per four characters, less one per padding character.
 */
function calculateBase64ByteLength(content: string): number {
  let paddingLength = 0
  if (content.endsWith("==")) paddingLength = 2
  else if (content.endsWith("=")) paddingLength = 1
  return (
    (content.length / BASE64_GROUP_LENGTH) * BASE64_GROUP_BYTES - paddingLength
  )
}

/**
 * Validates one attachment of a chat request: its name and its content.
 *
 * @remarks The content is base64 and decodes to at most
 * `MAXIMUM_ATTACHMENT_BYTES`. What the content is, text or an image, is read
 * from its bytes by the backend, never from the name.
 */
export const chatAttachmentSchema = z.strictObject({
  /** Name of the attachment, which is also its file name on disk. */
  name: attachmentNameSchema,
  /** Base64 of the attachment's bytes. */
  content: z
    .base64()
    .refine(
      (content) =>
        calculateBase64ByteLength(content) <= MAXIMUM_ATTACHMENT_BYTES,
      `An attachment has at most ${MAXIMUM_ATTACHMENT_BYTES} bytes.`
    )
})

/** One attachment of a chat request. */
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>

/**
 * Answers whether the attachments of a request together decode to at most
 * the message limit.
 *
 * @param attachments - Validated attachments of one request.
 * @returns True when their decoded sizes sum to at most
 * `MAXIMUM_MESSAGE_ATTACHMENT_BYTES`.
 */
function hasAttachmentsWithinMessageLimit(
  attachments: readonly ChatAttachment[]
): boolean {
  const totalBytes = attachments.reduce(
    (total, attachment) =>
      total + calculateBase64ByteLength(attachment.content),
    0
  )
  return totalBytes <= MAXIMUM_MESSAGE_ATTACHMENT_BYTES
}

/**
 * Validates the attachments of a chat request: at least one and at most
 * `MAXIMUM_MESSAGE_ATTACHMENT_COUNT`, each name once ignoring case, together
 * within `MAXIMUM_MESSAGE_ATTACHMENT_BYTES`.
 */
const chatAttachmentsSchema = z
  .array(chatAttachmentSchema)
  .min(1)
  .max(MAXIMUM_MESSAGE_ATTACHMENT_COUNT)
  .refine(
    (attachments) =>
      hasDistinctAttachmentNames(
        attachments.map((attachment) => attachment.name)
      ),
    "A message names each attachment once, ignoring case."
  )
  .refine(
    hasAttachmentsWithinMessageLimit,
    `A message's attachments have at most ${MAXIMUM_MESSAGE_ATTACHMENT_BYTES} bytes together.`
  )
  .readonly()

/** Validates generation controls forwarded to the backend model completion. */
export const messageGenerationOptionsSchema = z.strictObject({
  /** Sampling temperature coerced to a number and constrained from zero through one. */
  temperature: z.coerce.number().min(0).max(MAXIMUM_GENERATION_TEMPERATURE),
  /** Optional non-negative maximum completion-token count. */
  replyCeiling: z.coerce.number().int().min(0).optional()
})

/**
 * Validates the conversation a chat turn starts or continues.
 *
 * @remarks `kind` selects the variant. A new conversation names the built-in
 * or stored agent that answers it; a continued conversation keeps the agent
 * it was started with, so it names none.
 */
export const chatConversationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    /** The turn starts a new conversation. */
    kind: z.literal("new"),
    /** Code of the agent that answers the new conversation, such as `caliginia`. */
    agentCode: agentCodeSchema
  }),
  z.strictObject({
    /** The turn continues a stored conversation. */
    kind: z.literal("existing"),
    /** UUIDv7 of the stored conversation. */
    id: z.uuidv7()
  })
])

/**
 * Answers whether every offered definition is a tool the client runs.
 *
 * @param definitions - Validated definitions of the offered client tools.
 * @returns True when every definition's runner is `client`.
 */
function hasOnlyClientTools(definitions: readonly ToolDefinition[]): boolean {
  return isEveryToolRunBy(definitions, "client")
}

/**
 * Answers whether no backend tool name is offered twice.
 *
 * @param toolNames - Offered backend tool names in offer order.
 * @returns True when every name appears once.
 */
function hasDistinctBackendToolNames(toolNames: readonly string[]): boolean {
  return new Set(toolNames).size === toolNames.length
}

/** Explanation of a refused offer that names the backend's attachment reader. */
const RESERVED_TOOL_NAME_MESSAGE = `A request does not offer ${READ_ATTACHMENT_TOOL_NAME}; the backend adds it to a turn itself.`

/**
 * Answers whether no offered name is the backend's attachment reader, which
 * the backend adds to a turn itself.
 *
 * @param toolNames - Offered tool names.
 * @returns True when none is `READ_ATTACHMENT_TOOL_NAME`.
 */
function hasNoReservedToolName(toolNames: readonly string[]): boolean {
  return !toolNames.includes(READ_ATTACHMENT_TOOL_NAME)
}

/**
 * Validates each list of a chat tool offer on its own, before the checks
 * across both lists.
 */
const chatToolOfferListsSchema = z.strictObject({
  /**
   * Definitions of the switched-on client tools, each name once and none
   * named like the backend's attachment reader; may be empty.
   */
  definitions: z
    .array(toolDefinitionSchema)
    .refine(hasDistinctToolNames, "A request offers each tool name once.")
    .refine(hasOnlyClientTools, "Offered definitions are client tools.")
    .refine(
      (definitions) =>
        hasNoReservedToolName(definitions.map((tool) => tool.name)),
      RESERVED_TOOL_NAME_MESSAGE
    )
    .readonly(),
  /**
   * Names of the switched-on backend tools, each name once and none the
   * backend's attachment reader. Absence means the request offers no
   * backend tool.
   */
  backendToolNames: z
    .array(toolNameSchema)
    .refine(
      hasDistinctBackendToolNames,
      "A request offers each backend tool name once."
    )
    .refine(hasNoReservedToolName, RESERVED_TOOL_NAME_MESSAGE)
    .readonly()
    .optional()
})

/** Client and backend tools of one chat offer, before their combined checks. */
type ChatToolOfferCandidate = z.infer<typeof chatToolOfferListsSchema>

/**
 * Answers whether an offer names at least one tool.
 *
 * @param offer - Offered client definitions and backend tool names.
 * @returns True when either list holds a tool.
 */
function hasOfferedTool(offer: ChatToolOfferCandidate): boolean {
  return (
    offer.definitions.length > 0 || (offer.backendToolNames ?? []).length > 0
  )
}

/**
 * Answers whether no name is offered both as a client and as a backend tool.
 *
 * @param offer - Offered client definitions and backend tool names.
 * @returns True when the two lists share no name.
 */
function hasDistinctOfferedToolNames(offer: ChatToolOfferCandidate): boolean {
  const clientToolNames = new Set(offer.definitions.map((tool) => tool.name))
  return (offer.backendToolNames ?? []).every(
    (toolName) => !clientToolNames.has(toolName)
  )
}

/**
 * Validates the tools a chat request offers to the model.
 *
 * @remarks Lists the client's switched-on tools as complete definitions,
 * because the backend does not know them, and the switched-on tools the
 * backend runs by name, because the backend owns their definitions. At least
 * one tool is offered, no name is offered twice across the two lists, and
 * neither list names the backend's attachment reader
 * (`READ_ATTACHMENT_TOOL_NAME`), which the backend adds to a turn itself
 * when the conversation holds a text attachment. The backend rejects a
 * backend tool name it does not run (400) and an offered backend tool that
 * cannot run now (409). Offered only to a model trained for tool use.
 */
export const chatToolOfferSchema = chatToolOfferListsSchema
  .refine(hasOfferedTool, "A tool offer names at least one tool.")
  .refine(
    hasDistinctOfferedToolNames,
    "A request offers each tool name once across client and backend tools."
  )

/** Client and backend tools one chat request offers to the model. */
export type ChatToolOffer = z.infer<typeof chatToolOfferSchema>

/** Validates a chat request for a new or an existing conversation. */
export const chatApiRequestBodySchema = z.strictObject({
  /** Conversation the turn starts or continues. */
  conversation: chatConversationTargetSchema,
  /** Non-empty user-authored prompt sent to the selected model. */
  message: z.string().min(1),
  /** Non-empty model identifier resolved by the backend runtime. */
  model: z.string().min(1),
  /** Required generation controls; absence is not represented by this contract. */
  generationOptions: messageGenerationOptionsSchema,
  /**
   * Tools offered for this turn; absence means one round without tools.
   */
  tools: chatToolOfferSchema.optional(),
  /**
   * Files sent with the message, in the order they were attached; absence
   * means none. Each is stored with the message under its name.
   */
  attachments: chatAttachmentsSchema.optional()
})

/**
 * Validates the discriminated SSE event variants emitted by the chat route.
 *
 * @remarks The backend emits a start event before generation events. Exactly
 * one of `done`, `interrupted`, or `error` ends the reply: `done` after the
 * completed reply is stored, `interrupted` when it ended early because it was
 * stopped, superseded by a newer turn, deleted, or cancelled by shutdown, and
 * `error` after a generation failure. A `title` event follows the start event
 * either to reconcile an existing persisted title or to publish a newly
 * persisted title. A generated title may arrive before, between, or after the
 * reply events because its task runs concurrently. `reply-part`,
 * `reply-part-delta`, and `sources` events carry the reply's parts and the
 * sources its tool calls read, each stored before it is sent. The stream closes after
 * both tasks settle; like every generation stream (see
 * `ChatGenerationEvent`), it can close without a final reply event.
 * `tool-approval` events ask the client to show a call to the person; see
 * the tool-approval endpoint. `tool-call` events ask the client to run a call
 * of a client tool; see the tool-result endpoint. The `type` discriminant is the compatibility boundary used by
 * desktop consumers.
 */
export const chatApiStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start-new-conversation-turn"),
    /** Metadata for the newly created conversation. */
    conversation: conversationMetadataSchema,
    /** Persisted user message created before generation starts. */
    userMessage: conversationUserMessageSchema,
    /** Streaming assistant message without parts; later events add them. */
    assistantMessage: conversationAssistantMessageSchema
  }),

  z.strictObject({
    type: z.literal("start-existing-conversation-turn"),
    /** Persisted user message appended to the existing conversation. */
    userMessage: conversationUserMessageSchema,
    /** Streaming assistant message without parts; later events add them. */
    assistantMessage: conversationAssistantMessageSchema
  }),

  chatTitleEventSchema,
  chatReplyPartEventSchema,
  chatReplyPartDeltaEventSchema,
  chatSourcesEventSchema,
  chatDoneEventSchema,
  chatInterruptedEventSchema,
  chatErrorEventSchema,
  chatToolCallEventSchema,
  chatToolApprovalEventSchema
])

/**
 * Selects the validator of a chat failure sent before the stream starts, by
 * HTTP status.
 *
 * @remarks A 400 is the attachment-unsupported problem when an attachment's
 * content is neither text nor an image Lys sends; a body that fails
 * validation is answered with Fastify's own 400. A 404 is the
 * agent-not-found problem when a new conversation names a code no agent has,
 * and the conversation-not-found problem when a continued conversation is
 * not stored. A 409 is the conversation agent missing problem when the
 * continued conversation is stored but its agent no longer exists, the
 * backend tool unavailable problem when an offered backend tool cannot run
 * now, and the image-needs-vision problem when the request attaches an image
 * for a model without vision. A 503 is the service-busy or
 * runtime-unavailable problem when the request or the conversation holds
 * attachments and the model's capabilities cannot be read from LM Studio.
 */
const chatApiResponseSchemas = Object.freeze({
  400: chatAttachmentUnsupportedProblemSchema,
  404: z.union([agentNotFoundProblemSchema, conversationNotFoundProblemSchema]),
  409: z.union([
    conversationAgentMissingProblemSchema,
    chatBackendToolUnavailableProblemSchema,
    chatImageNeedsVisionProblemSchema
  ]),
  503: z.union([
    llmServiceBusyProblemSchema,
    llmRuntimeUnavailableProblemSchema
  ])
})

/**
 * Describes the POST chat endpoint and its text/event-stream response contract.
 *
 * @remarks Strict request and event schemas reject unknown fields. The required
 * generation options have no protocol-level default; an omitted
 * `replyCeiling` remains absent and is translated by the backend runtime.
 * The agent that answers is resolved before anything is stored, so a request
 * answered with one of the declared problems stored no message and started
 * no reply. Every turn sends the agent's current system prompt. The body is
 * limited to `MAXIMUM_CHAT_BODY_BYTES`, so a message can carry its
 * attachments; a stored attachment is listed on the user message of the turn
 * start event and of the conversation.
 * Closing the response stream ends only this client's observation: the
 * backend keeps generating and storing the reply and its title. The
 * reply-stop endpoint stops a reply, and the reply-events endpoint follows it
 * again. The descriptor is imported by backend and desktop transport code;
 * changing its method, path, status, content type, or schemas is a
 * compatibility change requiring coordinated consumers.
 */
export const chatApi = {
  method: "POST",
  path: apiChatRoute,
  bodyLimitBytes: MAXIMUM_CHAT_BODY_BYTES,
  body: chatApiRequestBodySchema,
  response: {
    status: 200,
    contentType: "text/event-stream",
    eventSchema: chatApiStreamEventSchema
  },
  responses: chatApiResponseSchemas
}

/** Request body accepted by the chat route after schema validation. */
export type ChatApiRequestBody = z.infer<typeof chatApi.body>

/** Response descriptor inferred from the chat route contract. */
export type ChatApiResponse = z.infer<typeof chatApi.response>

/** Typed event union accepted by the chat SSE transport. */
export type ChatApiStreamEvent = z.infer<typeof chatApiStreamEventSchema>

/** Generation controls accepted by the chat request contract. */
export type MessageGenerationOptions = z.infer<
  typeof messageGenerationOptionsSchema
>

/** Fastify route type carrying the validated chat request body. */
export type ChatApiRoute = {
  /** Validated request payload supplied to the backend handler. */
  Body: ChatApiRequestBody
}
