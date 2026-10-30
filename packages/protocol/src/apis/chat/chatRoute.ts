import { apiChatRoute } from "../llm"
import * as z from "zod"
import {
  agentCodeSchema,
  attachmentNameSchema,
  BACKEND_INTERNAL_TOOL_NAMES,
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationUserMessageSchema,
  hasDistinctAttachmentNames,
  hasDistinctToolNames,
  hasDistinctValues,
  isEveryToolRunBy,
  MAXIMUM_ATTACHMENT_BYTES,
  MAXIMUM_MESSAGE_ATTACHMENT_BYTES,
  MAXIMUM_MESSAGE_ATTACHMENT_COUNT,
  MAXIMUM_MCP_SERVER_COUNT,
  toolDefinitionSchema,
  toolNameSchema,
  type ToolDefinition
} from "@lys/share"
import { MAXIMUM_MCP_SERVER_TOOL_COUNT } from "../mcp/_share"
import {
  unavailableBackendToolSchema,
  type UnavailableBackendTool
} from "../tool/backendToolAvailability"
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
 * Lists the tools the backend adds to a turn itself for a refusal message.
 *
 * @returns `a, b, c, or d`, in {@link BACKEND_INTERNAL_TOOL_NAMES} order.
 */
function formatBackendInternalToolNames(): string {
  const names = [...BACKEND_INTERNAL_TOOL_NAMES]
  const lastName = names.pop()
  return `${names.join(", ")}, or ${lastName}`
}

/** Explanation of a refused offer that names a tool the backend adds itself. */
const RESERVED_TOOL_NAME_MESSAGE = `A request does not offer ${formatBackendInternalToolNames()}; the backend adds them to a turn itself.`

/**
 * Answers whether no name is a tool the backend adds to a turn itself.
 *
 * @param toolNames - Offered or named tool names.
 * @returns True when none is in `BACKEND_INTERNAL_TOOL_NAMES`.
 */
function hasNoReservedToolName(toolNames: readonly string[]): boolean {
  return !toolNames.some((toolName) =>
    BACKEND_INTERNAL_TOOL_NAMES.includes(toolName)
  )
}

/**
 * Most backend tool names one request offers: every tool of the most MCP
 * servers the settings hold, each with the most tools the backend reads,
 * plus 64 for the backend's own tools, far more than it has.
 *
 * @remarks Bounds the list before the backend looks up any name. Raising it
 * requires a coordinated backend and desktop release.
 */
export const MAXIMUM_OFFERED_BACKEND_TOOL_COUNT =
  MAXIMUM_MCP_SERVER_COUNT * MAXIMUM_MCP_SERVER_TOOL_COUNT + 64

/**
 * Validates each list of a chat tool offer on its own, before the checks
 * across both lists.
 */
const chatToolOfferListsSchema = z.strictObject({
  /**
   * Definitions of the switched-on client tools, each name once and none
   * named like a tool the backend adds itself; may be empty.
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
   * Names of the switched-on tools from the backend's tool list, each name
   * once and none a tool the backend adds itself: the backend's own tools
   * and the tools of its MCP servers; at most
   * {@link MAXIMUM_OFFERED_BACKEND_TOOL_COUNT}. Absence means the request
   * offers no backend tool.
   */
  backendToolNames: z
    .array(toolNameSchema)
    .max(MAXIMUM_OFFERED_BACKEND_TOOL_COUNT)
    .refine(hasDistinctValues, "A request offers each backend tool name once.")
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
 * neither list names a tool the backend adds to a turn itself
 * (`BACKEND_INTERNAL_TOOL_NAMES`): the attachment reader, when the
 * conversation holds a text attachment, and the agent state tools. The
 * backend rejects a backend tool name it does not run (400) and an offered
 * backend tool that cannot run now (409), such as an MCP tool whose server
 * is configured but not connected. Offered only to a model trained for tool
 * use.
 */
export const chatToolOfferSchema = chatToolOfferListsSchema
  .refine(hasOfferedTool, "A tool offer names at least one tool.")
  .refine(
    hasDistinctOfferedToolNames,
    "A request offers each tool name once across client and backend tools."
  )

/** Client and backend tools one chat request offers to the model. */
export type ChatToolOffer = z.infer<typeof chatToolOfferSchema>

/**
 * Most tools one request names in each list of tools it does not offer: the
 * switched-off tools, and the switched-on tools that cannot run now.
 *
 * @remarks Far more than Lys's own tools, so it never limits a real
 * request, while bounding each list in the note the backend adds to the
 * turn's instructions to 64 names of at most 64 characters each. MCP tools
 * are never named in these lists, because one server alone may list more.
 */
const MAXIMUM_UNOFFERED_TOOL_COUNT = 64

/**
 * Explanation of a refused switched-off or unavailable list that names a
 * tool the backend adds to a turn itself.
 */
const RESERVED_UNOFFERED_TOOL_NAME_MESSAGE = `A request does not name ${formatBackendInternalToolNames()} as switched off or unable to run; they have no switch and the backend adds them to a turn itself.`

/**
 * Validates the names of the tools the person switched off in the client.
 *
 * @remarks One to {@link MAXIMUM_UNOFFERED_TOOL_COUNT} names, each passing
 * the shared tool-name rule, each once, and none a tool the backend adds to
 * a turn itself, which has no switch. A name need not be a tool the backend runs,
 * because the client's own tools are named too. The backend tells the model
 * these tools are off and answers a call of one as off; it never runs one.
 */
export const switchedOffToolNamesSchema = z
  .array(toolNameSchema)
  .min(1)
  .max(MAXIMUM_UNOFFERED_TOOL_COUNT)
  .refine(hasDistinctValues, "A request names each switched-off tool once.")
  .refine(hasNoReservedToolName, RESERVED_UNOFFERED_TOOL_NAME_MESSAGE)
  .readonly()

/**
 * Answers whether no unavailable tool is one the backend adds to a turn
 * itself.
 *
 * @param unavailableTools - Validated unavailable tools of one request.
 * @returns True when none is in `BACKEND_INTERNAL_TOOL_NAMES`.
 */
function hasNoReservedUnavailableTool(
  unavailableTools: readonly UnavailableBackendTool[]
): boolean {
  return hasNoReservedToolName(unavailableTools.map((tool) => tool.name))
}

/**
 * Validates the backend tools the person switched on that cannot run now,
 * each with why, as the client last read them from the backend's tool list.
 *
 * @remarks One to {@link MAXIMUM_UNOFFERED_TOOL_COUNT} tools, each name once
 * and none a tool the backend adds to a turn itself. The backend rejects a
 * name it does not run (400) but does not check the reason again, so the
 * note repeats the client's reading. The backend tells the model these tools
 * cannot run now, why, and what would fix it, and answers a call of one the
 * same way; it never runs one.
 */
export const unavailableToolsSchema = z
  .array(unavailableBackendToolSchema)
  .min(1)
  .max(MAXIMUM_UNOFFERED_TOOL_COUNT)
  .refine(
    (unavailableTools) =>
      hasDistinctValues(unavailableTools.map((tool) => tool.name)),
    "A request names each tool that cannot run once."
  )
  .refine(hasNoReservedUnavailableTool, RESERVED_UNOFFERED_TOOL_NAME_MESSAGE)
  .readonly()

/**
 * Validates that the person switched tool calls off in the client.
 *
 * @remarks Only `true` is accepted; absence means tool calls are on, so the
 * field has one representation for each state. The backend tells the model
 * tool calls are off and answers a call of a tool it is not offered the same
 * way.
 */
export const areToolCallsSwitchedOffSchema = z.literal(true)

/**
 * The tool fields of one request, before the checks across them.
 *
 * @remarks Every field is absent or undefined when the request leaves it
 * out.
 */
type ToolChoiceCandidate = Readonly<{
  /** Offered tools. */
  tools?: ChatToolOffer | undefined
  /** Switched-off tool names. */
  switchedOffToolNames?: readonly string[] | undefined
  /** Switched-on backend tools that cannot run now. */
  unavailableTools?: readonly UnavailableBackendTool[] | undefined
  /** `true` when tool calls are switched off. */
  areToolCallsSwitchedOff?: true | undefined
}>

/**
 * Answers whether no tool is named in two of a request's tool lists.
 *
 * @param candidate - The request's offer, switched-off names, and
 * unavailable tools, each list already free of repeats.
 * @returns True when no name is offered and switched off, offered and
 * unavailable, or switched off and unavailable, also when lists are absent.
 */
export function hasDistinctToolChoiceNames(
  candidate: ToolChoiceCandidate
): boolean {
  const offeredNames = [
    ...(candidate.tools?.definitions ?? []).map((tool) => tool.name),
    ...(candidate.tools?.backendToolNames ?? [])
  ]
  const unavailableNames = (candidate.unavailableTools ?? []).map(
    (tool) => tool.name
  )
  return hasDistinctValues([
    ...offeredNames,
    ...(candidate.switchedOffToolNames ?? []),
    ...unavailableNames
  ])
}

/** Explanation of a refused request that names one tool in two tool lists. */
export const TOOL_NAMED_TWICE_MESSAGE =
  "A request names each tool once across its offered, switched-off, and unable-to-run tools."

/**
 * Answers whether a request with tool calls switched off leaves out every
 * other tool field.
 *
 * @param candidate - The request's tool fields.
 * @returns True when tool calls are on, or when they are off and the request
 * offers no tool and names none as switched off or unable to run.
 */
export function hasNoToolListWhileToolCallsOff(
  candidate: ToolChoiceCandidate
): boolean {
  if (candidate.areToolCallsSwitchedOff === undefined) return true
  return (
    candidate.tools === undefined &&
    candidate.switchedOffToolNames === undefined &&
    candidate.unavailableTools === undefined
  )
}

/**
 * Explanation of a refused request that switches tool calls off and still
 * offers or names tools.
 */
export const TOOL_LIST_WHILE_TOOL_CALLS_OFF_MESSAGE =
  "A request with tool calls switched off offers no tool and names none as switched off or unable to run."

/**
 * Validates a chat request for a new or an existing conversation.
 *
 * @remarks A tool is named at most once across the offered, switched-off,
 * and unavailable tools, and a request with tool calls switched off names
 * no tool in any of them.
 */
export const chatApiRequestBodySchema = z
  .strictObject({
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
     * Tools the person switched off, by name; absence means none is. The
     * backend tells the model they are off.
     */
    switchedOffToolNames: switchedOffToolNamesSchema.optional(),
    /**
     * Switched-on backend tools that cannot run now, each with why; absence
     * means none. The backend tells the model they cannot run and why.
     */
    unavailableTools: unavailableToolsSchema.optional(),
    /**
     * `true` when the person switched tool calls off; absence means they
     * are on. The backend tells the model tool calls are off.
     */
    areToolCallsSwitchedOff: areToolCallsSwitchedOffSchema.optional(),
    /**
     * Files sent with the message, in the order they were attached; absence
     * means none. Each is stored with the message under its name.
     */
    attachments: chatAttachmentsSchema.optional()
  })
  .refine(hasDistinctToolChoiceNames, TOOL_NAMED_TWICE_MESSAGE)
  .refine(
    hasNoToolListWhileToolCallsOff,
    TOOL_LIST_WHILE_TOOL_CALLS_OFF_MESSAGE
  )

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
 * agent-not-found problem when a new conversation names a code no agent has
 * or a deleted agent's, and the conversation-not-found problem when a
 * continued conversation is not stored. A 409 is the conversation agent
 * missing problem when the continued conversation is stored but its agent no
 * longer exists, the backend tool unavailable problem when an offered
 * backend tool cannot run now, and the image-needs-vision problem when the
 * request attaches an image for a model without vision. A 503 is the
 * service-busy or runtime-unavailable problem when the model's capabilities,
 * which every request reads, cannot be read from LM Studio.
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
