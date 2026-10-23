import {
  chatContextApi,
  createLlmHealthProblem,
  type ChatContextApiRequestBody,
  type ChatContextApiRoute
} from "@lys/protocol"
import type {
  Conversation,
  ConversationMessage,
  ToolDefinition
} from "@lys/share"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { GetAttachmentImageFileStatus } from "../../agent/agentContext"
import type AttachmentFileStore from "../../attachment/attachmentFileStore"
import type { AttachmentFileStatus } from "../../attachment/attachmentFileStore"
import { buildAttachmentImageFileStatusLookup } from "../../attachment/attachmentImageReader"
import {
  buildReadAttachmentDefinition,
  hasReadableTextAttachment,
  listReadableAttachments,
  type ReadableAttachment
} from "../../attachment/readAttachmentTool"
import handleLlmServiceRequestFailure from "../../llm/routes/handleLlmServiceRequestFailure"
import type { BuiltInToolEntry } from "../../tool/builtIn/builtInTool"
import {
  createModelCapabilitiesLookup,
  findListedModelCapabilities,
  NO_MODEL_CAPABILITIES,
  type FindModelCapabilities
} from "./modelCapabilities"
import {
  findRequestedAgent,
  findRequestedBuiltInTools,
  findUnofferedTools,
  sendUnansweredTurnProblem,
  type TurnAgentLookups
} from "./turnRequest"

/** Lookups the chat-context route borrows for its lifetime. */
type ChatContextRouteDependencies = Pick<TurnAgentLookups, "findChatAgent"> &
  Readonly<{
    /**
     * Stored conversation with its messages and their attachments; undefined
     * means it is not stored.
     */
    findConversation: (conversationId: string) => Conversation | undefined
    /** Every tool the backend runs, which a request may offer by name. */
    builtInTools: readonly BuiltInToolEntry[]
    /**
     * Capabilities of the model a request names, read from LM Studio's
     * inventory.
     */
    findModelCapabilities: FindModelCapabilities
    /** Examines stored attachment files without reading them. */
    attachmentFiles: Pick<AttachmentFileStore, "getAttachmentFileStatus">
  }>

/**
 * Stored transcript of a measured conversation, its attachments, and the
 * lookup of its image files.
 */
type MeasuredHistory = Readonly<{
  /** Stored messages in conversation order; empty for a new conversation. */
  history: readonly ConversationMessage[]
  /** Every attachment of the stored messages, in conversation order. */
  attachments: readonly ReadableAttachment[]
  /**
   * Finds whether one stored image's file is among the conversation's
   * files, without reading it.
   */
  getAttachmentImageFileStatus: GetAttachmentImageFileStatus
}>

/** Stored messages of a conversation that has none yet. */
const NO_CONVERSATION_MESSAGES: readonly ConversationMessage[] = Object.freeze(
  []
)

/** Attachments of a conversation that has no message yet. */
const NO_CONVERSATION_ATTACHMENTS: readonly ReadableAttachment[] =
  Object.freeze([])

/** History of a new conversation: no message, so no attachment to look up. */
const NEW_CONVERSATION_HISTORY: MeasuredHistory = Object.freeze({
  history: NO_CONVERSATION_MESSAGES,
  attachments: NO_CONVERSATION_ATTACHMENTS,
  getAttachmentImageFileStatus: () =>
    Promise.resolve<AttachmentFileStatus>("missing")
})

/** Explanation sent when no loaded instance matches the requested model. */
const MODEL_NOT_LOADED_DETAIL =
  "The model is not loaded in LM Studio. Load it in Settings → Model to measure the conversation."

/**
 * Registers the endpoint that measures the context a conversation's next
 * message would be sent with.
 *
 * @param app - Backend with validation, the Zod response serializer, the
 * agent service, the conversation reader, the LLM service behind the agents,
 * the backend tools, and the attachment file store installed.
 * @throws If route registration fails.
 * @remarks Every response prevents caching, because a measurement observes
 * the loaded model at the moment it ran. A full model-operation queue and a
 * missing or lost LLM runtime are answered with their 503 problems.
 */
export default function registerChatContextRoute(app: FastifyInstance): void {
  const dependencies = {
    findChatAgent: (code: string) => app.agentService.findChatAgent(code),
    findConversation: (conversationId: string) =>
      app.conversationHistoryReader.getConversation(conversationId),
    builtInTools: app.builtInTools,
    findModelCapabilities: createModelCapabilitiesLookup(() =>
      app.llmService.listDownloadedLlmModels()
    ),
    attachmentFiles: app.attachmentFileStore
  } satisfies ChatContextRouteDependencies
  app.route<ChatContextApiRoute>({
    method: chatContextApi.method,
    url: chatContextApi.path,
    schema: { body: chatContextApi.body, response: chatContextApi.responses },
    onRequest: (_request, reply) => {
      reply.header("Cache-Control", "no-store")
      return Promise.resolve()
    },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async (request, reply) =>
      await handleChatContextRequest(request, reply, dependencies)
  })
}

/**
 * Measures the context of the requested conversation's next message and
 * sends it.
 *
 * @param request - Validated chat-context input.
 * @param reply - Response owner.
 * @param dependencies - Borrowed agent, conversation, tool, and model
 * lookups, and the attachment files.
 * @returns Settlement after the measurement or a problem is sent.
 * @throws An `UnknownBackendToolError` for an offered backend tool the
 * backend does not run, or for a tool named as unable to run that the
 * backend does not run; the inventory read's failure; and the agent's
 * measurement failure, for the route's error handler.
 * @remarks A continued conversation is read once, and its agent and stored
 * messages both come from that read, before the measurement waits for the
 * model's runtime. Whether the model sees images and is trained for tool
 * use is read from LM Studio's inventory only when a stored message has an
 * attachment, so the history's images and the attachment reader are
 * measured as a turn would send and offer them; a model the inventory does
 * not list sees no image and is offered no reader. Image files are looked
 * up, never read: an image counts from its stored sides.
 */
async function handleChatContextRequest(
  request: FastifyRequest<ChatContextApiRoute>,
  reply: FastifyReply<ChatContextApiRoute>,
  dependencies: ChatContextRouteDependencies
): Promise<void> {
  const { body } = request
  const builtInTools = findRequestedBuiltInTools(
    dependencies.builtInTools,
    body.tools
  )
  const unofferedTools = findUnofferedTools(dependencies.builtInTools, body)
  const storedConversation =
    body.conversation.kind === "existing"
      ? dependencies.findConversation(body.conversation.id)
      : undefined
  const requestedAgent = findRequestedAgent(body.conversation, {
    findChatAgent: dependencies.findChatAgent,
    findConversationAgentCode: () => storedConversation?.agentCode
  })
  if (requestedAgent.status !== "found") {
    sendUnansweredTurnProblem(reply, requestedAgent, request.url)
    return
  }
  const measured = buildMeasuredHistory(
    storedConversation,
    dependencies.attachmentFiles
  )
  const capabilities =
    measured.attachments.length > 0
      ? await findListedModelCapabilities(
          body.model,
          dependencies.findModelCapabilities
        )
      : NO_MODEL_CAPABILITIES
  const measurement = await requestedAgent.agent.findContextMeasurement({
    history: measured.history,
    model: body.model,
    canSeeImages: capabilities.vision,
    getAttachmentImageFileStatus: measured.getAttachmentImageFileStatus,
    tools: buildOfferedDefinitions(
      body,
      builtInTools,
      capabilities.trainedForToolUse &&
        hasReadableTextAttachment(measured.attachments)
    ),
    unofferedTools
  })
  if (measurement === undefined) {
    const problem = createLlmHealthProblem({
      reason: "model-not-loaded",
      detail: MODEL_NOT_LOADED_DETAIL,
      instance: request.url
    })
    reply.type("application/problem+json").code(problem.status).send(problem)
    return
  }
  reply.code(200).send(measurement)
}

/**
 * Builds the stored transcript a measurement includes, with its attachments
 * and the lookup of its image files.
 *
 * @param storedConversation - The continued conversation; undefined for a
 * new one.
 * @param attachmentFiles - Examines stored attachment files.
 * @returns The conversation's messages, their attachments, and a lookup of
 * its image files; {@link NEW_CONVERSATION_HISTORY} for a new conversation.
 */
function buildMeasuredHistory(
  storedConversation: Conversation | undefined,
  attachmentFiles: Pick<AttachmentFileStore, "getAttachmentFileStatus">
): MeasuredHistory {
  if (storedConversation === undefined) return NEW_CONVERSATION_HISTORY
  const conversationId = storedConversation.id
  return {
    history: storedConversation.messages,
    attachments: listReadableAttachments(
      conversationId,
      storedConversation.messages
    ),
    getAttachmentImageFileStatus: buildAttachmentImageFileStatusLookup(
      conversationId,
      attachmentFiles
    )
  }
}

/**
 * Builds the definitions of the tools a turn would offer, as it orders them.
 *
 * @param body - Validated chat-context input.
 * @param builtInTools - The offered backend tools, in offer order.
 * @param offersReader - Whether the turn would offer the attachment reader:
 * the conversation holds a text attachment and the model is trained for
 * tool use.
 * @returns The client definitions first, then the backend tools', then the
 * reader's when the turn offers it.
 */
function buildOfferedDefinitions(
  body: ChatContextApiRequestBody,
  builtInTools: readonly BuiltInToolEntry[],
  offersReader: boolean
): readonly ToolDefinition[] {
  return [
    ...(body.tools?.definitions ?? []),
    ...builtInTools.map((entry) => entry.definition),
    ...(offersReader ? [buildReadAttachmentDefinition()] : [])
  ]
}
