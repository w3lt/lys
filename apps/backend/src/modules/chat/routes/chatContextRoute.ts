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
import type { McpTurnToolLookup } from "../../mcp/mcpServerRegistry"
import type { BuiltInToolEntry } from "../../tool/builtIn/builtInTool"
import {
  findListedModelCapabilities,
  type FindModelCapabilities
} from "./modelCapabilities"
import {
  loadRequestedAgent,
  findRequestedBackendTools,
  findUnofferedTools,
  sendUnansweredTurnProblem,
  type RequestedBackendTools,
  type TurnAgentLookups
} from "./turnRequest"

/** Lookups the chat-context route borrows for its lifetime. */
type ChatContextRouteDependencies = Pick<TurnAgentLookups, "loadChatAgent"> &
  Readonly<{
    /**
     * Stored conversation with its messages and their attachments; undefined
     * means it is not stored.
     */
    findConversation: (conversationId: string) => Conversation | undefined
    /** Every built-in tool, which a request may offer by name. */
    builtInTools: readonly BuiltInToolEntry[]
    /**
     * Looks up one MCP tool a request offers by name, in the servers as they
     * are now.
     */
    findMcpTool: (toolName: string) => McpTurnToolLookup
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
 * agent runtime service, the conversation reader, the LLM service behind the
 * agents, the built-in tools, the MCP server registry, and the attachment
 * file store installed.
 * @param findModelCapabilities - Capabilities of the model a request names,
 * read from LM Studio's inventory and remembered by the lookup; shared with
 * the chat route, so a measurement offers what a turn would.
 * @throws If route registration fails.
 * @remarks Every response prevents caching, because a measurement observes
 * the loaded model at the moment it ran. A full model-operation queue and a
 * missing or lost LLM runtime are answered with their 503 problems.
 */
export default function registerChatContextRoute(
  app: FastifyInstance,
  findModelCapabilities: FindModelCapabilities
): void {
  const dependencies = {
    loadChatAgent: (code: string) =>
      app.agentRuntimeService.loadChatAgent(code),
    findConversation: (conversationId: string) =>
      app.conversationHistoryReader.getConversation(conversationId),
    builtInTools: app.builtInTools,
    findMcpTool: (toolName: string) =>
      app.mcpServerRegistry.findTurnTool(toolName),
    findModelCapabilities,
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
 * backend does not run, such as a tool no applied MCP server lists, or for
 * a tool named as unable to run that the backend does not run; the
 * inventory read's failure; and the agent's measurement failure, for the
 * route's error handler.
 * @remarks A continued conversation is read once, and its agent and stored
 * messages both come from that read, before the measurement waits for the
 * model's runtime. Whether the model sees images and is trained for tool
 * use is read through the capability lookup for every measurement, after
 * the agent is found, so the history's images and the tools the backend
 * adds are measured as a turn would send and offer them; a model the
 * inventory does not list sees no image and is offered no reader. Image
 * files are looked up, never read: an image counts from its stored sides.
 * An offered MCP tool whose server is not connected is left out, because
 * its definition is known only while the server is connected.
 */
async function handleChatContextRequest(
  request: FastifyRequest<ChatContextApiRoute>,
  reply: FastifyReply<ChatContextApiRoute>,
  dependencies: ChatContextRouteDependencies
): Promise<void> {
  const { body } = request
  const requestedTools = findRequestedBackendTools(
    dependencies.builtInTools,
    dependencies.findMcpTool,
    body.tools
  )
  const unofferedTools = findUnofferedTools(dependencies.builtInTools, body)
  const storedConversation =
    body.conversation.kind === "existing"
      ? dependencies.findConversation(body.conversation.id)
      : undefined
  const requestedAgent = loadRequestedAgent(body.conversation, {
    loadChatAgent: dependencies.loadChatAgent,
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
  const capabilities = await findListedModelCapabilities(
    body.model,
    dependencies.findModelCapabilities
  )
  const measurement = await requestedAgent.agent.findContextMeasurement({
    history: measured.history,
    model: body.model,
    canSeeImages: capabilities.vision,
    getAttachmentImageFileStatus: measured.getAttachmentImageFileStatus,
    trainedForToolUse: capabilities.trainedForToolUse,
    tools: buildOfferedDefinitions(
      body,
      requestedTools,
      capabilities.trainedForToolUse &&
        hasReadableTextAttachment(measured.attachments)
    ),
    unofferedTools
  })
  if (measurement === undefined) {
    sendModelNotLoadedProblem(reply, request.url)
    return
  }
  reply.code(200).send(measurement)
}

/**
 * Sends the problem for a request whose model is not loaded.
 *
 * @param reply - HTTP response owner.
 * @param instance - Path of the request, for the problem's `instance`.
 */
function sendModelNotLoadedProblem(
  reply: FastifyReply<ChatContextApiRoute>,
  instance: string
): void {
  const problem = createLlmHealthProblem({
    reason: "model-not-loaded",
    detail: MODEL_NOT_LOADED_DETAIL,
    instance
  })
  reply.type("application/problem+json").code(problem.status).send(problem)
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
 * @param requestedTools - The offered backend tools, in offer order.
 * @param offersReader - Whether the turn would offer the attachment reader:
 * the conversation holds a text attachment and the model is trained for
 * tool use.
 * @returns The client definitions first, then the built-in tools', then the
 * reader's when the turn offers it, then the connected MCP tools'.
 */
function buildOfferedDefinitions(
  body: ChatContextApiRequestBody,
  requestedTools: RequestedBackendTools,
  offersReader: boolean
): readonly ToolDefinition[] {
  return [
    ...(body.tools?.definitions ?? []),
    ...requestedTools.builtInTools.map((entry) => entry.definition),
    ...(offersReader ? [buildReadAttachmentDefinition()] : []),
    ...requestedTools.mcpTools.map((tool) => tool.definition)
  ]
}
