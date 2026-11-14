import {
  chatApi,
  type ChatApiRequestBody,
  type ChatApiRoute,
  type ChatApiStreamEvent,
  type ChatAttachmentUnsupportedProblem,
  type ChatBackendToolUnavailableProblem,
  type ChatImageNeedsVisionProblem
} from "@lys/protocol"
import type {
  Conversation,
  ConversationMetadata,
  ToolDefinition
} from "@lys/share"
import type { FastifyInstance } from "fastify"
import { v7 as uuidv7 } from "uuid"
import type Agent from "../../agent/agent"
import type { UnofferedTools } from "../../agent/unofferedTools"
import type AttachmentFileStore from "../../attachment/attachmentFileStore"
import {
  parseChatAttachments,
  type ParsedChatAttachment
} from "../../attachment/chatAttachments"
import handleLlmServiceRequestFailure from "../../llm/routes/handleLlmServiceRequestFailure"
import type {
  McpTurnToolLookup,
  TurnMcpTool
} from "../../mcp/mcpServerRegistry"
import type {
  BuiltInToolEntry,
  TurnBuiltInTool
} from "../../tool/builtIn/builtInTool"
import { findTurnBuiltInTools } from "../../tool/builtIn/builtInTools"
import type {
  ConversationTurn,
  ConversationTurnAuthor,
  ConversationTurnTarget,
  ConversationTurnUserMessage,
  ConversationTurnWriter,
  CreateConversationTurnOptions
} from "../persistence"
import ReplyEventSubscription from "../replyEventSubscription"
import type { StartTurn, TurnDelegationHooks, TurnSettings } from "../turnStart"
import {
  findListedModelCapabilities,
  type FindModelCapabilities,
  type ModelCapabilities
} from "./modelCapabilities"
import {
  createChatAttachmentUnsupportedProblem,
  createChatBackendToolUnavailableProblem,
  createChatImageNeedsVisionProblem
} from "./replyProblems"
import {
  createEventSender,
  openReplyEventStream,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"
import {
  loadRequestedAgent,
  findRequestedBackendTools,
  findUnofferedTools,
  sendUnansweredTurnProblem,
  type MissingRequestedAgentOutcome,
  type TurnAgentLookups
} from "./turnRequest"

/** What the chat route does with attachment files. */
type AttachmentFiles = Pick<
  AttachmentFileStore,
  | "saveMessageAttachments"
  | "deleteMessageAttachments"
  | "deleteConversationAttachments"
>

/**
 * Capabilities borrowed for the lifetime of a registered chat route,
 * including the agent lookup.
 */
type ChatRouteDependencies = Pick<TurnAgentLookups, "loadChatAgent"> &
  Readonly<{
    /** Turn persistence that stores each request's turn. */
    turns: Pick<ConversationTurnWriter, "createConversationTurn">
    /**
     * Stored conversation with its messages and their attachments; undefined
     * means it is not stored.
     */
    findConversation: (conversationId: string) => Conversation | undefined
    /**
     * Capabilities of the model a request names, read from the connected
     * provider's inventory.
     */
    findModelCapabilities: FindModelCapabilities
    /**
     * Saves each turn's attachment files, and deletes them when the turn is
     * not stored.
     */
    attachmentFiles: AttachmentFiles
    /** Every built-in tool, which a request may offer by name. */
    builtInTools: readonly BuiltInToolEntry[]
    /**
     * Looks up one MCP tool a request offers by name, in the servers as they
     * are now.
     */
    findMcpTool: (toolName: string) => McpTurnToolLookup
    /**
     * Starts the generation of each stored turn, in the registry that owns
     * every running generation.
     */
    startTurn: StartTurn
    /** Hooks through which each person's turn takes part in delegation. */
    turnDelegations: TurnDelegationHooks
  }>

/** Problems the chat route sends before the stream starts. */
type ChatRouteProblem =
  | ChatAttachmentUnsupportedProblem
  | ChatBackendToolUnavailableProblem
  | ChatImageNeedsVisionProblem

/** What a request parsed and looked up before its turn is stored. */
type AcceptedTurnRequest = Readonly<{
  /**
   * The request's attachments, decoded and classified, in request order;
   * empty when it carries none.
   */
  attachments: readonly ParsedChatAttachment[]
  /** Built-in tools the request offered, found for the turn. */
  builtInTools: readonly TurnBuiltInTool[]
  /** MCP tools the request offered, each of a connected server. */
  mcpTools: readonly TurnMcpTool[]
  /** Whether the request offered `delegate_work`. */
  offersDelegateWork: boolean
  /** What the request names about the tools the turn does not offer. */
  unofferedTools: UnofferedTools
  /**
   * What the model can do with attachments; both false when neither the
   * request nor the conversation holds any.
   */
  capabilities: ModelCapabilities
}>

/** The backend tools a request offers, found for its turn. */
type OfferedBackendTools = Readonly<{
  /** Offered built-in tools, each ready to run, in offer order. */
  builtInTools: readonly TurnBuiltInTool[]
  /** Offered MCP tools, each of a connected server, in offer order. */
  mcpTools: readonly TurnMcpTool[]
  /**
   * Whether the request offers `delegate_work`, which is in neither list:
   * the agent adds it itself to a turn that may delegate.
   */
  offersDelegateWork: boolean
}>

/**
 * The conversation a request continues, as stored when an agent was found
 * for the request.
 */
type CheckedTurnConversation = Readonly<{
  /** The continued conversation; undefined for a new one. */
  storedConversation: Conversation | undefined
}>

/** A stored turn with the agent that answers it. */
type SavedTurn = Readonly<{
  /** The turn is stored. */
  status: "saved"
  /** Stored turn and prior transcript snapshot. */
  turn: ConversationTurn
  /** Agent that answers the turn, found as the turn was stored. */
  agent: Agent
}>

/** Outcome of storing a turn: the stored turn, or why no agent answers it. */
type SavedTurnOutcome = SavedTurn | MissingRequestedAgentOutcome

/**
 * Installs the chat endpoint, which stores a turn, starts its generation, and
 * follows that generation on the response stream.
 *
 * @param app - Backend with SSE, validation, and singleton services
 * installed, whose turn start starts each stored turn's generation, with the
 * delegation hooks every turn the route starts takes part in delegation
 * through.
 * @param findModelCapabilities - Capabilities of the model a request names,
 * read from the connected provider's inventory and remembered by the lookup
 * while that provider stays connected; shared with the chat-context route.
 * @throws If route registration fails.
 * @remarks The route accepts bodies up to the chat contract's limit, so a
 * message can carry its attachments. A full model-operation queue and a
 * missing or lost LLM runtime, met while a model's capabilities are read,
 * are answered with their 503 problems.
 */
export default function updateFastifyWithChatRoute(
  app: FastifyInstance,
  findModelCapabilities: FindModelCapabilities
): void {
  const dependencies = {
    turns: app.conversationTurns,
    loadChatAgent: (code: string) =>
      app.agentRuntimeService.loadChatAgent(code),
    findConversation: (conversationId: string) =>
      app.conversationHistoryReader.getConversation(conversationId),
    findModelCapabilities,
    attachmentFiles: app.attachmentFileStore,
    builtInTools: app.builtInTools,
    findMcpTool: (toolName: string) =>
      app.mcpServerRegistry.findTurnTool(toolName),
    startTurn: app.startTurn,
    turnDelegations: app.turnDelegations
  }
  app.route<ChatApiRoute>({
    method: chatApi.method,
    url: chatApi.path,
    bodyLimit: chatApi.bodyLimitBytes,
    sse: "only",
    schema: { body: chatApi.body },
    errorHandler: handleLlmServiceRequestFailure,
    handler: async (request, reply) =>
      handleChatRequest(request, reply, dependencies)
  })
}

/**
 * Stores a turn, starts its generation, and follows it on this request's
 * stream.
 *
 * @param request - Validated chat input and request logger.
 * @param reply - SSE or pre-stream error response owner.
 * @param dependencies - Borrowed persistence, agents, files, and turn start.
 * @returns Settlement after the stream ends, or after a problem response.
 * @throws An `UnknownBackendToolError`, before anything is stored, when the
 * request offers a backend tool the backend does not run, such as a tool no
 * applied MCP server lists, or names one as unable to run; the inventory
 * read's failure, before anything is stored, when the model's capabilities
 * are needed and cannot be read; and unexpected failures before the stream
 * starts, for the route's error boundary. A request answered with one of
 * the chat contract's problems stored nothing.
 * @remarks Closing this stream does not cancel the generation. Everything
 * the turn needs is parsed and looked up, as {@link parseTurnRequest}
 * describes, before the request's attachment files are saved. The agent is
 * then found again and the turn is stored in one synchronous step, as
 * {@link saveTurn} describes, so the agent that answers is the one the
 * conversation has when the turn is stored, whatever changed while the files
 * were written or the inventory was read; a conversation or agent deleted by
 * then refuses the turn with its problem. The generation and this follower
 * are created right after, and the follower receives the start event before
 * any generation event. The agent answers with the system prompt it has when
 * the turn is stored. The turn keeps the backend tools found for it, so a
 * key saved or removed while it runs applies from the next request. An MCP
 * tool's call runs on its server as connected when the call runs, and fails
 * for the model when the server is no longer connected or no longer lists
 * the tool. The turn is started with the application's delegation hooks,
 * so it takes part in delegation: for a model trained for tool use, its
 * agent is offered `delegate_work` when the request offers it in a main
 * conversation and the agent's role may delegate, and `stop_job` once the
 * conversation has a job.
 */
async function handleChatRequest(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: ChatRouteDependencies
): Promise<void> {
  const accepted = await parseTurnRequest(request, reply, dependencies)
  if (accepted === undefined) return
  const saved = await saveTurn(request.body, accepted.attachments, dependencies)
  if (saved.status !== "saved") {
    sendUnansweredTurnProblem(reply, saved, request.url)
    return
  }
  const generation = dependencies.startTurn({
    turn: saved.turn,
    agent: saved.agent,
    settings: buildTurnSettings(request.body, accepted),
    startedBy: "person",
    delegation: dependencies.turnDelegations,
    logger: request.log
  })
  const subscription = new ReplyEventSubscription<ChatApiStreamEvent>(
    createEventSender<ChatApiStreamEvent>(reply.sse)
  )
  for (const event of buildTurnStartEvents(saved.turn))
    subscription.handleStreamEvent(event)
  generation.openSubscription(subscription)
  await openReplyEventStream(reply.sse, subscription)
}

/**
 * Parses a request and looks up what its turn needs before the turn is
 * stored, or answers the request with the problem that refuses it.
 *
 * @param request - Validated chat input.
 * @param reply - Response owner; the response has not started.
 * @param dependencies - Borrowed agent, conversation, tool, and model lookups.
 * @returns The accepted request, or undefined once a problem was sent: the
 * attachment-unsupported problem for an attachment whose content is neither
 * text nor an image Lys sends, the backend-tool-unavailable problem for an
 * offered built-in tool that cannot run now or an offered MCP tool whose
 * server is not connected, the problem that says why no
 * agent answers, or the image-needs-vision problem for an image attached
 * for a model that cannot see images, including a model the inventory does
 * not list. Nothing is stored or written either way.
 * @throws An `UnknownBackendToolError` for an offered backend tool the
 * backend does not run, or for a tool named as unable to run that the
 * backend does not run; the inventory read's failure; and any persistence
 * failure of a lookup.
 * @remarks The attachments are decoded first, then the tools named as
 * unable to run are checked and every offered backend tool is looked up:
 * the built-in tools' availability first, then the MCP tools' servers,
 * while `delegate_work` is only noted as offered, because the agent adds
 * that tool itself;
 * then the conversation is read once and an agent is
 * looked up for the request, so a request no agent answers is refused
 * before the inventory is read; the conversation's stored attachments come
 * from that read. The model's capabilities are then read for every turn,
 * because they decide the images the model sees and the tools the backend
 * offers it; the lookup lists the connected provider's inventory only until
 * it has seen the model, so only a model's first turn with that provider
 * waits for the model-operation queue. The agent found here is not kept: the lookup that decides who
 * answers runs again when the turn is stored.
 */
async function parseTurnRequest(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: ChatRouteDependencies
): Promise<AcceptedTurnRequest | undefined> {
  const { body } = request
  const attachments = parseChatAttachments(body.attachments)
  if (attachments.status === "unsupported") {
    sendProblem(
      reply,
      createChatAttachmentUnsupportedProblem(attachments.fileName, request.url)
    )
    return undefined
  }
  const unofferedTools = findUnofferedTools(dependencies.builtInTools, body)
  const backendTools = await findOfferedBackendTools(
    request,
    reply,
    dependencies
  )
  if (backendTools === undefined) return undefined
  const checked = findTurnConversation(request, reply, dependencies)
  if (checked === undefined) return undefined
  const capabilities = await findListedModelCapabilities(
    body.model,
    dependencies.findModelCapabilities
  )
  const unseenImage = findUnseenImage(attachments.attachments, capabilities)
  if (unseenImage !== undefined) {
    sendProblem(
      reply,
      createChatImageNeedsVisionProblem(
        unseenImage.name,
        body.model,
        request.url
      )
    )
    return undefined
  }
  return {
    attachments: attachments.attachments,
    builtInTools: backendTools.builtInTools,
    mcpTools: backendTools.mcpTools,
    offersDelegateWork: backendTools.offersDelegateWork,
    unofferedTools,
    capabilities
  }
}

/**
 * Finds the conversation a request continues, once an agent answers the
 * request as it stands, or answers the request with the problem that says
 * why no agent does.
 *
 * @param request - Validated chat input.
 * @param reply - Response owner; the response has not started.
 * @param dependencies - Borrowed agent and conversation lookups.
 * @returns The continued conversation as stored now, undefined inside for a
 * new one; or undefined once the problem that says why no agent answers was
 * sent: for a job, the conversation-is-job problem.
 * @throws Any persistence failure of a lookup.
 * @remarks The conversation is read once, here; the agent lookup uses that
 * read, and the caller takes the stored attachments from it. The agent is
 * not returned, because it is looked up again when the turn is stored. A
 * job is refused here, before its agent is looked up. It is not asked again
 * when the turn is stored: a conversation is a job from its creation on, so
 * one that passed here is still a main conversation then.
 */
function findTurnConversation(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: Pick<
    ChatRouteDependencies,
    "loadChatAgent" | "findConversation"
  >
): CheckedTurnConversation | undefined {
  const { conversation } = request.body
  const storedConversation =
    conversation.kind === "existing"
      ? dependencies.findConversation(conversation.id)
      : undefined
  if (
    storedConversation !== undefined &&
    storedConversation.parentConversationId !== null
  ) {
    sendUnansweredTurnProblem(
      reply,
      { status: "conversation-is-job", conversationId: storedConversation.id },
      request.url
    )
    return undefined
  }
  const requestedAgent = loadRequestedAgent(conversation, {
    loadChatAgent: dependencies.loadChatAgent,
    findConversationAgentCode: () => storedConversation?.agentCode
  })
  if (requestedAgent.status !== "found") {
    sendUnansweredTurnProblem(reply, requestedAgent, request.url)
    return undefined
  }
  return { storedConversation }
}

/**
 * Finds the backend tools a request offers for its turn, or answers the
 * request with the problem that refuses one.
 *
 * @param request - Validated chat input.
 * @param reply - Response owner; the response has not started.
 * @param dependencies - Every built-in tool and the MCP tool lookup.
 * @returns The offered built-in and MCP tools found for the turn, each in
 * offer order, and whether the request offers `delegate_work`; or undefined
 * once the backend-tool-unavailable problem was sent for an offered built-in
 * tool that cannot run now or, after those, an offered MCP tool whose server
 * is not connected.
 * @throws An `UnknownBackendToolError` for an offered backend tool the
 * backend does not run.
 */
async function findOfferedBackendTools(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: Pick<ChatRouteDependencies, "builtInTools" | "findMcpTool">
): Promise<OfferedBackendTools | undefined> {
  const requested = findRequestedBackendTools(
    dependencies.builtInTools,
    dependencies.findMcpTool,
    request.body.tools
  )
  const found = await findTurnBuiltInTools(requested.builtInTools)
  if (found.status === "unavailable") {
    sendProblem(
      reply,
      createChatBackendToolUnavailableProblem(
        found.toolName,
        found.reason,
        request.url
      )
    )
    return undefined
  }
  if (requested.notConnectedMcpToolName !== undefined) {
    sendProblem(
      reply,
      createChatBackendToolUnavailableProblem(
        requested.notConnectedMcpToolName,
        "mcp-server-not-connected",
        request.url
      )
    )
    return undefined
  }
  return {
    builtInTools: found.tools,
    mcpTools: requested.mcpTools,
    offersDelegateWork: requested.offersDelegateWork
  }
}

/**
 * Finds an image attached for a model that cannot see it.
 *
 * @param attachments - The request's decoded attachments.
 * @param capabilities - What the model can do with attachments.
 * @returns The first image attachment when the model has no vision;
 * undefined when it has, or when no image is attached.
 */
function findUnseenImage(
  attachments: readonly ParsedChatAttachment[],
  capabilities: ModelCapabilities
): ParsedChatAttachment | undefined {
  if (capabilities.vision) return undefined
  return attachments.find((attachment) => attachment.draft.kind === "image")
}

/**
 * Sends one of the chat route's problem responses.
 *
 * @param reply - Response owner; the response has not started.
 * @param problem - Problem describing why the request is refused.
 */
function sendProblem(reply: ChatRouteReply, problem: ChatRouteProblem): void {
  reply.type("application/problem+json").code(problem.status).send(problem)
}

/**
 * Saves the request's attachment files, then finds the agent that answers
 * and stores the turn.
 *
 * @param body - Validated chat input.
 * @param attachments - The request's decoded attachments in request order.
 * @param dependencies - Borrowed turn persistence, attachment files, and
 * agent and conversation lookups.
 * @returns The stored turn, whose user message carries the attachments
 * numbered after the conversation's, with the agent that answers it; or why
 * no agent answers, once the files written for the turn are deleted again.
 * @throws The file store's failure, before anything is stored; it deletes
 * what it saved for the message. The turn persistence's failure after the
 * files were saved, once they are deleted again, or an `AggregateError`
 * holding that failure and the deletion's when they cannot be deleted; they
 * then stay, under a message the conversation never stores. The deletion's
 * failure when the files of a turn no agent answers cannot be deleted.
 * @remarks The identities of a new conversation and of the user message are
 * made here, before the files are saved under them, so the files are in
 * place when the turn commits. A request without attachments saves no
 * folder and deletes none. The agent is looked up and the turn is stored in
 * one synchronous step after the files are saved, as
 * {@link createAnsweredTurn} describes, so a conversation or agent deleted
 * while the files were written refuses the turn instead of storing it under
 * a stale agent. The files of a turn that is not stored go as
 * {@link deleteWrittenAttachments} describes.
 */
async function saveTurn(
  body: ChatApiRequestBody,
  attachments: readonly ParsedChatAttachment[],
  dependencies: Pick<
    ChatRouteDependencies,
    "turns" | "attachmentFiles" | "loadChatAgent" | "findConversation"
  >
): Promise<SavedTurnOutcome> {
  const turnOptions = buildTurnOptions(body, attachments)
  if (attachments.length === 0)
    return createAnsweredTurn(body.conversation, turnOptions, dependencies)
  const { attachmentFiles } = dependencies
  await attachmentFiles.saveMessageAttachments(
    turnOptions.conversation.id,
    turnOptions.userMessage.id,
    attachments
  )
  let saved: SavedTurnOutcome
  try {
    saved = createAnsweredTurn(body.conversation, turnOptions, dependencies)
  } catch (error) {
    await deleteAttachmentsAfterFailure(attachmentFiles, turnOptions, error)
    throw error
  }
  if (saved.status !== "saved")
    await deleteWrittenAttachments(
      attachmentFiles,
      turnOptions,
      body.conversation.kind === "existing" &&
        saved.status !== "conversation-not-found"
    )
  return saved
}

/**
 * Builds the turn a request stores.
 *
 * @param body - Validated chat input.
 * @param attachments - The request's decoded attachments in request order.
 * @returns The turn with the identities of a new conversation and of the
 * user message, made here so the attachment files can be saved under them
 * before the turn commits, and the attachments' drafts in request order. The
 * person is the author of the message.
 */
function buildTurnOptions(
  body: ChatApiRequestBody,
  attachments: readonly ParsedChatAttachment[]
): CreateConversationTurnOptions {
  const conversation: ConversationTurnTarget =
    body.conversation.kind === "new"
      ? { kind: "new", id: uuidv7(), agentCode: body.conversation.agentCode }
      : body.conversation
  const author: ConversationTurnAuthor = { origin: "person" }
  const userMessage: ConversationTurnUserMessage = {
    id: uuidv7(),
    content: body.message,
    attachments: attachments.map((attachment) => attachment.draft),
    author
  }
  return { conversation, userMessage, model: body.model }
}

/**
 * Finds the agent that answers a turn as its request stands now and stores
 * the turn, in one synchronous step.
 *
 * @param requested - Conversation the validated request starts or continues.
 * @param turnOptions - The turn to store.
 * @param dependencies - Borrowed turn persistence and agent and conversation
 * lookups.
 * @returns The stored turn with its agent; or why no agent answers, with
 * nothing stored: a new conversation names a code no agent has, the
 * continued conversation is not stored, or its agent no longer exists.
 * @throws Any persistence failure of a lookup, and the turn persistence's
 * failure.
 * @remarks Nothing awaits between the lookup and the write, so the stored
 * turn's conversation has the agent that answers it.
 */
function createAnsweredTurn(
  requested: ChatApiRequestBody["conversation"],
  turnOptions: CreateConversationTurnOptions,
  dependencies: Pick<
    ChatRouteDependencies,
    "turns" | "loadChatAgent" | "findConversation"
  >
): SavedTurnOutcome {
  const requestedAgent = loadRequestedAgent(requested, {
    loadChatAgent: dependencies.loadChatAgent,
    findConversationAgentCode: (conversationId) =>
      dependencies.findConversation(conversationId)?.agentCode
  })
  if (requestedAgent.status !== "found") return requestedAgent
  return {
    status: "saved",
    turn: dependencies.turns.createConversationTurn(turnOptions),
    agent: requestedAgent.agent
  }
}

/**
 * Deletes the files written for a turn that is not stored.
 *
 * @param attachmentFiles - Borrowed attachment files.
 * @param turnOptions - The turn, whose files were written under its
 * conversation and message.
 * @param isConversationStored - Whether the turn's conversation is stored:
 * false for a new conversation, and for a continued one that was deleted
 * while the turn was prepared.
 * @returns Settlement once the files are gone: with the conversation's whole
 * folder when the conversation is not stored, as nothing of it stays; with
 * the message's folder otherwise, so the conversation's other files stay.
 * @throws If the folder cannot be removed.
 */
async function deleteWrittenAttachments(
  attachmentFiles: Pick<
    AttachmentFiles,
    "deleteMessageAttachments" | "deleteConversationAttachments"
  >,
  turnOptions: CreateConversationTurnOptions,
  isConversationStored: boolean
): Promise<void> {
  const { conversation, userMessage } = turnOptions
  if (isConversationStored)
    await attachmentFiles.deleteMessageAttachments(
      conversation.id,
      userMessage.id
    )
  else await attachmentFiles.deleteConversationAttachments(conversation.id)
}

/**
 * Deletes a turn's saved attachment files after the turn could not be
 * stored.
 *
 * @param attachmentFiles - Borrowed attachment files.
 * @param turnOptions - The turn, whose files were written under its
 * conversation and message.
 * @param turnFailure - Failure of the turn's persistence.
 * @returns Settlement once the files are gone, as
 * {@link deleteWrittenAttachments} removes them for a conversation that is
 * stored when the turn continues one.
 * @throws An `AggregateError` holding the turn failure and the deletion's
 * failure when the files cannot be deleted.
 */
async function deleteAttachmentsAfterFailure(
  attachmentFiles: Pick<
    AttachmentFiles,
    "deleteMessageAttachments" | "deleteConversationAttachments"
  >,
  turnOptions: CreateConversationTurnOptions,
  turnFailure: unknown
): Promise<void> {
  try {
    await deleteWrittenAttachments(
      attachmentFiles,
      turnOptions,
      turnOptions.conversation.kind === "existing"
    )
  } catch (error) {
    throw new AggregateError(
      [turnFailure, error],
      "Attachment files could not be deleted after the turn failed to store",
      { cause: error }
    )
  }
}

/**
 * Builds the settings a stored turn's reply is written with.
 *
 * @param body - Validated chat input.
 * @param accepted - What the request parsed and looked up before the turn
 * was stored.
 * @returns The request's model, generation options, and client tools, none
 * when it offered none; the backend tools found for the turn, to which the
 * turn start adds the attachment reader; whether the request offered
 * `delegate_work`; what the request names about the tools the turn does not
 * offer; and whether the model sees images and is trained for tool use.
 */
function buildTurnSettings(
  body: ChatApiRequestBody,
  accepted: AcceptedTurnRequest
): TurnSettings {
  /** Client tools of a request that offered none. */
  const noRequestedTools: readonly ToolDefinition[] = Object.freeze([])

  return {
    model: body.model,
    generationOptions: body.generationOptions,
    clientTools: body.tools?.definitions ?? noRequestedTools,
    builtInTools: accepted.builtInTools,
    mcpTools: accepted.mcpTools,
    offersDelegateWork: accepted.offersDelegateWork,
    unofferedTools: accepted.unofferedTools,
    canSeeImages: accepted.capabilities.vision,
    trainedForToolUse: accepted.capabilities.trainedForToolUse
  }
}

/**
 * Builds the metadata of a stored conversation: the conversation without its
 * messages, sources, and jobs, in the same variant.
 *
 * @param conversation - Stored conversation snapshot.
 * @returns Its identity, title, agent, and times, with its parent, job
 * number, and delegator, which a main conversation has none of.
 */
function buildConversationMetadata(
  conversation: Conversation
): ConversationMetadata {
  const { id, title, agentCode, createdAt, updatedAt } = conversation
  const fields = { id, title, agentCode, createdAt, updatedAt }
  if (conversation.parentConversationId === null)
    return {
      ...fields,
      parentConversationId: null,
      jobNumber: null,
      delegatorAgentCode: null
    }
  const { parentConversationId, jobNumber, delegatorAgentCode } = conversation
  return { ...fields, parentConversationId, jobNumber, delegatorAgentCode }
}

/**
 * Builds the events that open a turn's stream.
 *
 * @param turn - Stored pair and conversation snapshot.
 * @returns The turn-start event, followed by the stored title of an existing
 * titled conversation.
 * @remarks The stored title lets a client that missed an earlier title event
 * reconcile its metadata. New and untitled conversations get no title here.
 */
function buildTurnStartEvents(turn: ConversationTurn): ChatApiStreamEvent[] {
  const { userMessage, assistantMessage } = turn
  if (turn.isNewConversation) {
    return [
      {
        type: "start-new-conversation-turn",
        conversation: buildConversationMetadata(turn.conversation),
        userMessage,
        assistantMessage
      }
    ]
  }

  const start: ChatApiStreamEvent = {
    type: "start-existing-conversation-turn",
    userMessage,
    assistantMessage
  }
  const { title } = turn.conversation
  if (title === null) return [start]
  const storedTitle: ChatApiStreamEvent = { type: "title", title }
  return [start, storedTitle]
}
