import {
  chatApi,
  type ChatApiRequestBody,
  type ChatApiRoute,
  type ChatApiStreamEvent,
  type ChatAttachmentUnsupportedProblem,
  type ChatBackendToolUnavailableProblem,
  type ChatImageNeedsVisionProblem,
  type MessageGenerationOptions
} from "@lys/protocol"
import type { Conversation, ToolDefinition } from "@lys/share"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import { v7 as uuidv7 } from "uuid"
import type { BackendConfig } from "../../../config"
import type Agent from "../../agent/agent"
import type { AgentTurn } from "../../agent/agent"
import type { FindAttachmentImage } from "../../agent/agentContext"
import type AttachmentFileStore from "../../attachment/attachmentFileStore"
import {
  parseChatAttachments,
  type ParsedChatAttachment
} from "../../attachment/chatAttachments"
import ReadAttachmentTool, {
  buildReadAttachmentDefinition,
  hasReadableTextAttachment,
  listReadableAttachments,
  type ReadableAttachment,
  type ReadAttachmentFile
} from "../../attachment/readAttachmentTool"
import handleLlmServiceRequestFailure from "../../llm/routes/handleLlmServiceRequestFailure"
import type {
  BuiltInToolEntry,
  TurnBuiltInTool
} from "../../tool/builtIn/builtInTool"
import { findTurnBuiltInTools } from "../../tool/builtIn/builtInTools"
import type ToolApprovalService from "../../toolApproval/toolApprovalService"
import type { TitleGenerationOptions } from "../chatService"
import type {
  ConversationTurn,
  ConversationTurnTarget,
  ConversationTurnWriter,
  GeneratedConversationTitleWriter,
  ReplyPartWriter
} from "../persistence"
import ReplyEventSubscription from "../replyEventSubscription"
import type ReplyGeneration from "../replyGeneration"
import type {
  ReplyGenerationTaskContext,
  ReplyTaskContext
} from "../replyGeneration"
import type ReplyGenerationRegistry from "../replyGenerationRegistry"
import createTitleGenerationTask from "../titleGenerationTask"
import {
  createModelCapabilitiesLookup,
  findAttachmentModelCapabilities,
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
  findRequestedAgent,
  findRequestedBuiltInTools,
  sendUnansweredTurnProblem,
  type TurnAgentLookups
} from "./turnRequest"

/** Backend settings the chat route applies to every request. */
export type ChatRouteOptions = Pick<BackendConfig, "titleGenerationMaxAttempts">

/** Settings and the generation registry the chat route is installed with. */
export type ChatRouteRegistration = ChatRouteOptions &
  Readonly<{
    /** Registry owning every generation this route starts; not disposed here. */
    generations: ReplyGenerationRegistry
  }>

/** What the chat route does with attachment files. */
type AttachmentFiles = Pick<
  AttachmentFileStore,
  "saveMessageAttachments" | "deleteMessageAttachments" | "readAttachment"
>

/**
 * Capabilities and settings borrowed for the lifetime of a registered chat
 * route, including the agent lookup.
 */
type ChatRouteDependencies = Pick<TurnAgentLookups, "findChatAgent"> &
  Readonly<{
    /** Turn persistence whose lifetime outlives all active generations. */
    turns: ConversationTurnWriter
    /** Reply-part persistence whose lifetime outlives all active generations. */
    replyParts: ReplyPartWriter
    /** Conditional generated-title persistence borrowed for the route lifetime. */
    titleWriter: GeneratedConversationTitleWriter
    /**
     * Stored conversation with its messages and their attachments; undefined
     * means it is not stored.
     */
    findConversation: (conversationId: string) => Conversation | undefined
    /**
     * Capabilities of the model a request names, read from LM Studio's
     * inventory.
     */
    findModelCapabilities: FindModelCapabilities
    /**
     * Saves each turn's attachment files, deletes them when the turn cannot
     * be stored, and reads stored ones.
     */
    attachmentFiles: AttachmentFiles
    /** Bound title operation retained separately from chat completion. */
    generateTitle: (options: TitleGenerationOptions) => Promise<string>
    /**
     * Context length a model is loaded with, observed through the
     * model-operation queue without loading it; undefined when it is not
     * loaded.
     */
    findLoadedContextLength: (model: string) => Promise<number | undefined>
    /** Inclusive maximum number of title requests permitted for one turn. */
    titleGenerationMaxAttempts: number
    /** Registry that owns every generation this route starts. */
    generations: ReplyGenerationRegistry
    /** Every tool the backend runs, which a request may offer by name. */
    builtInTools: readonly BuiltInToolEntry[]
    /** Approval gateway every tool call of every turn passes. */
    toolApprovals: ToolApprovalService
  }>

/** Problems the chat route sends before the stream starts. */
type ChatRouteProblem =
  | ChatAttachmentUnsupportedProblem
  | ChatBackendToolUnavailableProblem
  | ChatImageNeedsVisionProblem

/** What a request resolved before its turn is stored. */
type AcceptedTurnRequest = Readonly<{
  /**
   * The request's attachments, decoded and classified, in request order;
   * empty when it carries none.
   */
  attachments: readonly ParsedChatAttachment[]
  /** Backend tools the request offered, found for the turn. */
  builtInTools: readonly TurnBuiltInTool[]
  /** Agent that answers. */
  agent: Agent
  /**
   * What the model can do with attachments; both false when neither the
   * request nor the conversation holds any.
   */
  capabilities: ModelCapabilities
}>

/** The agent that answers a turn, with the continued conversation it was read from. */
type ResolvedTurnAgent = Readonly<{
  /** Agent that answers. */
  agent: Agent
  /** The continued conversation; undefined for a new one. */
  storedConversation: Conversation | undefined
}>

/** Warning logged when a round's calls all ask because the choices are unreadable. */
const UNREADABLE_JUST_RUN_CHOICES_MESSAGE =
  "The saved Just run choices could not be read from settings.json; every tool call of this round asks the person"

/** Client tools of a request that offered none. */
const NO_REQUESTED_TOOLS: readonly ToolDefinition[] = Object.freeze([])

/** Values one turn's tasks keep after the request that started them ended. */
type TurnGenerationInput = Readonly<{
  /** Stored turn and prior transcript snapshot. */
  turn: ConversationTurn
  /** Agent that answers the turn. */
  agent: Agent
  /** Model selected by the request. */
  model: string
  /** Sampling and reply length controls sent with the request. */
  generationOptions: MessageGenerationOptions
  /** Client tools the request offered, each name once; empty when it offered none. */
  clientTools: readonly ToolDefinition[]
  /**
   * Backend tools of the turn, each name once: the ones the request offered,
   * then the attachment reader when the turn offers it; empty when none.
   */
  builtInTools: readonly TurnBuiltInTool[]
  /** Whether the model sees images. */
  canSeeImages: boolean
  /** Reads the bytes of one stored image attachment of the conversation. */
  findAttachmentImage: FindAttachmentImage
  /** Logger of the request that started the turn. */
  logger: FastifyBaseLogger
  /** Route capabilities borrowed for the route lifetime. */
  dependencies: ChatRouteDependencies
}>

/**
 * Installs the chat endpoint, which stores a turn, starts its generation, and
 * follows that generation on the response stream.
 *
 * @param app - Backend with SSE, validation, and singleton services installed.
 * @param registration - Title attempt limit and the registry that owns the
 * started generations.
 * @throws If route registration fails.
 * @remarks The route accepts bodies up to the chat contract's limit, so a
 * message can carry its attachments. A full model-operation queue and a
 * missing or lost LLM runtime, met while a model's capabilities are read,
 * are answered with their 503 problems.
 */
export default function updateFastifyWithChatRoute(
  app: FastifyInstance,
  { titleGenerationMaxAttempts, generations }: ChatRouteRegistration
): void {
  const turns = app.conversationTurns
  const dependencies = {
    turns,
    replyParts: app.replyParts,
    titleWriter: turns,
    findChatAgent: (code: string) => app.agentService.findChatAgent(code),
    findConversation: (conversationId: string) =>
      app.conversationHistoryReader.getConversation(conversationId),
    findModelCapabilities: createModelCapabilitiesLookup(() =>
      app.llmService.listLlmModels()
    ),
    attachmentFiles: app.attachmentFileStore,
    generateTitle: (options: TitleGenerationOptions) =>
      app.chatService.generateTitle(options),
    findLoadedContextLength: async (model: string) =>
      (await app.llmService.findLlmContextMeasurement(model, []))
        ?.contextLength,
    titleGenerationMaxAttempts,
    generations,
    builtInTools: app.builtInTools,
    toolApprovals: app.toolApprovalService
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
 * @param dependencies - Borrowed persistence, agents, files, and registry.
 * @returns Settlement after the stream ends, or after a problem response.
 * @throws An `UnknownBackendToolError`, before anything is stored, when the
 * request offers a backend tool the backend does not run; the inventory
 * read's failure, before anything is stored, when the model's capabilities
 * are needed and cannot be read; and unexpected failures before the stream
 * starts, for the route's error boundary. A request answered with one of
 * the chat contract's problems stored nothing.
 * @remarks Closing this stream does not cancel the generation. Everything
 * the turn needs is resolved, as {@link resolveTurnRequest} describes,
 * before the request's attachment files are saved and the turn is stored;
 * the turn, the generation, and this follower are then created in the same
 * synchronous step, so no agent, turn, or conversation changes in between
 * and the follower receives the start event before any generation event.
 * The agent stored with the turn's conversation answers it, with the system
 * prompt it has when the turn starts. The turn keeps the backend tools found
 * for it, so a key saved or removed while it runs applies from the next
 * request.
 */
async function handleChatRequest(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: ChatRouteDependencies
): Promise<void> {
  const accepted = await resolveTurnRequest(request, reply, dependencies)
  if (accepted === undefined) return
  const turn = await saveTurn(request.body, accepted.attachments, dependencies)
  const generation = startTurnGeneration(
    buildTurnGenerationInput(request, accepted, turn, dependencies)
  )
  const subscription = new ReplyEventSubscription<ChatApiStreamEvent>(
    createEventSender<ChatApiStreamEvent>(reply.sse)
  )
  for (const event of buildTurnStartEvents(turn))
    subscription.handleStreamEvent(event)
  generation.openSubscription(subscription)
  await openReplyEventStream(reply.sse, subscription)
}

/**
 * Resolves everything a request needs before its turn is stored, or answers
 * it with the problem that refuses it.
 *
 * @param request - Validated chat input.
 * @param reply - Response owner; the response has not started.
 * @param dependencies - Borrowed agent, conversation, tool, and model lookups.
 * @returns The accepted request, or undefined once a problem was sent: the
 * attachment-unsupported problem for an attachment whose content is neither
 * text nor an image Lys sends, the backend-tool-unavailable problem for an
 * offered backend tool that cannot run now, the problem that says why no
 * agent answers, or the image-needs-vision problem for an image attached
 * for a model that cannot see images, including a model the inventory does
 * not list. Nothing is stored or written either way.
 * @throws An `UnknownBackendToolError` for an offered backend tool the
 * backend does not run; the inventory read's failure; and any persistence
 * failure of a lookup.
 * @remarks The attachments are decoded first, then every offered backend
 * tool is looked up, then the agent is found; a continued conversation is
 * read once, and its agent and its stored attachments both come from that
 * read. The model's capabilities are read from LM Studio only when the
 * request or the conversation holds an attachment, so a turn without any
 * never waits for the model-operation queue.
 */
async function resolveTurnRequest(
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
  const builtInTools = await resolveTurnBuiltInTools(
    request,
    reply,
    dependencies.builtInTools
  )
  if (builtInTools === undefined) return undefined
  const resolvedAgent = resolveTurnAgent(request, reply, dependencies)
  if (resolvedAgent === undefined) return undefined
  const capabilities = await findAttachmentModelCapabilities(
    body.model,
    hasTurnAttachments(
      resolvedAgent.storedConversation,
      attachments.attachments
    ),
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
    builtInTools,
    agent: resolvedAgent.agent,
    capabilities
  }
}

/**
 * Resolves the agent that answers a request's turn, or answers the request
 * with the problem that says why no agent does.
 *
 * @param request - Validated chat input.
 * @param reply - Response owner; the response has not started.
 * @param dependencies - Borrowed agent and conversation lookups.
 * @returns The agent with the continued conversation it was read from, or
 * undefined once the problem that says why no agent answers was sent.
 * @throws Any persistence failure of a lookup.
 * @remarks A continued conversation is read once, here; its agent comes
 * from that read, and the caller takes its stored attachments from it.
 */
function resolveTurnAgent(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: Pick<
    ChatRouteDependencies,
    "findChatAgent" | "findConversation"
  >
): ResolvedTurnAgent | undefined {
  const { conversation } = request.body
  const storedConversation =
    conversation.kind === "existing"
      ? dependencies.findConversation(conversation.id)
      : undefined
  const requestedAgent = findRequestedAgent(conversation, {
    findChatAgent: dependencies.findChatAgent,
    findConversationAgentCode: () => storedConversation?.agentCode
  })
  if (requestedAgent.status !== "found") {
    sendUnansweredTurnProblem(reply, requestedAgent, request.url)
    return undefined
  }
  return { agent: requestedAgent.agent, storedConversation }
}

/**
 * Resolves the backend tools a request offers for its turn, or answers the
 * request with the problem that refuses one.
 *
 * @param request - Validated chat input.
 * @param reply - Response owner; the response has not started.
 * @param builtInTools - Every tool the backend runs.
 * @returns The offered tools found for the turn, in offer order; or
 * undefined once the backend-tool-unavailable problem was sent for an
 * offered tool that cannot run now.
 * @throws An `UnknownBackendToolError` for an offered backend tool the
 * backend does not run.
 */
async function resolveTurnBuiltInTools(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  builtInTools: readonly BuiltInToolEntry[]
): Promise<readonly TurnBuiltInTool[] | undefined> {
  const found = await findTurnBuiltInTools(
    findRequestedBuiltInTools(builtInTools, request.body.tools)
  )
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
  return found.tools
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
 * Answers whether a turn involves an attachment.
 *
 * @param storedConversation - The continued conversation; undefined for a
 * new one.
 * @param attachments - The request's decoded attachments.
 * @returns True when the request carries an attachment or a stored user
 * message of the conversation has one.
 */
function hasTurnAttachments(
  storedConversation: Conversation | undefined,
  attachments: readonly ParsedChatAttachment[]
): boolean {
  if (attachments.length > 0) return true
  return (
    storedConversation?.messages.some(
      (message) => message.role === "user" && message.attachments.length > 0
    ) ?? false
  )
}

/**
 * Saves the request's attachment files, then stores the turn.
 *
 * @param body - Validated chat input.
 * @param attachments - The request's decoded attachments in request order.
 * @param dependencies - Borrowed turn persistence and attachment files.
 * @returns The stored turn, whose user message carries the attachments
 * numbered after the conversation's.
 * @throws The file store's failure, before anything is stored; it deletes
 * what it saved for the message. The turn persistence's failure after the
 * files were saved, once the message's folder is deleted again, or an
 * `AggregateError` holding that failure and the deletion's when the folder
 * cannot be deleted; it then stays, under a message the conversation never
 * stores.
 * @remarks The identities of a new conversation and of the user message are
 * made here, before the files are saved under them, so the files are in
 * place when the turn commits. A request without attachments saves no
 * folder and deletes none.
 */
async function saveTurn(
  body: ChatApiRequestBody,
  attachments: readonly ParsedChatAttachment[],
  dependencies: Pick<ChatRouteDependencies, "turns" | "attachmentFiles">
): Promise<ConversationTurn> {
  const conversation: ConversationTurnTarget =
    body.conversation.kind === "new"
      ? { kind: "new", id: uuidv7(), agentCode: body.conversation.agentCode }
      : body.conversation
  const userMessageId = uuidv7()
  const turnOptions = {
    conversation,
    userMessage: {
      id: userMessageId,
      content: body.message,
      attachments: attachments.map((attachment) => attachment.draft)
    },
    model: body.model
  }
  if (attachments.length === 0)
    return dependencies.turns.createConversationTurn(turnOptions)
  const { attachmentFiles } = dependencies
  await attachmentFiles.saveMessageAttachments(
    conversation.id,
    userMessageId,
    attachments
  )
  try {
    return dependencies.turns.createConversationTurn(turnOptions)
  } catch (turnFailure) {
    await deleteAttachmentsAfterFailure(
      attachmentFiles,
      { conversationId: conversation.id, messageId: userMessageId },
      turnFailure
    )
    throw turnFailure
  }
}

/**
 * Deletes a message's saved attachment files after its turn could not be
 * stored.
 *
 * @param attachmentFiles - Borrowed attachment files.
 * @param message - Conversation and message the files were saved under.
 * @param turnFailure - Failure of the turn's persistence.
 * @returns Settlement once the message's folder is gone.
 * @throws An `AggregateError` holding the turn failure and the deletion's
 * failure when the folder cannot be deleted.
 */
async function deleteAttachmentsAfterFailure(
  attachmentFiles: Pick<AttachmentFiles, "deleteMessageAttachments">,
  message: Readonly<{ conversationId: string; messageId: string }>,
  turnFailure: unknown
): Promise<void> {
  try {
    await attachmentFiles.deleteMessageAttachments(
      message.conversationId,
      message.messageId
    )
  } catch (deletionFailure) {
    throw new AggregateError(
      [turnFailure, deletionFailure],
      "Attachment files could not be deleted after the turn failed to store",
      { cause: deletionFailure }
    )
  }
}

/**
 * Builds the values a stored turn's tasks keep.
 *
 * @param request - Validated chat input and request logger.
 * @param accepted - What the request resolved before the turn was stored.
 * @param turn - The stored turn.
 * @param dependencies - Route capabilities borrowed for the route lifetime.
 * @returns The turn with its agent, request values, the backend tools of the
 * turn, as {@link buildTurnBuiltInTools} builds them from the attachments of
 * the stored transcript and the new message, whether the model sees images,
 * and the reader of the conversation's stored images.
 */
function buildTurnGenerationInput(
  request: ChatRouteRequest,
  accepted: AcceptedTurnRequest,
  turn: ConversationTurn,
  dependencies: ChatRouteDependencies
): TurnGenerationInput {
  const { body } = request
  const { attachmentFiles } = dependencies
  const conversationId = turn.conversation.id
  const readableAttachments = listReadableAttachments(conversationId, [
    ...turn.conversation.messages,
    turn.userMessage
  ])
  return {
    turn,
    agent: accepted.agent,
    model: body.model,
    generationOptions: body.generationOptions,
    clientTools: body.tools?.definitions ?? NO_REQUESTED_TOOLS,
    builtInTools: buildTurnBuiltInTools(
      accepted.builtInTools,
      accepted.capabilities.trainedForToolUse,
      readableAttachments,
      (location) => attachmentFiles.readAttachment(location)
    ),
    canSeeImages: accepted.capabilities.vision,
    findAttachmentImage: (messageId, attachment) =>
      attachmentFiles.readAttachment({
        conversationId,
        messageId,
        name: attachment.name
      }),
    logger: request.log,
    dependencies
  }
}

/**
 * Builds the backend tools of one turn.
 *
 * @param offeredTools - Backend tools the request offered, found for the
 * turn.
 * @param canUseTools - Whether the model is trained for tool use.
 * @param attachments - Every attachment of the conversation, the new
 * message's included.
 * @param readAttachmentFile - Reads an attachment's file; lent for the turn.
 * @returns The offered tools, followed by the attachment reader when the
 * model is trained for tool use and an attachment is a text file; the
 * reader's calls run without approval, as they read only what the person
 * attached to this conversation.
 */
function buildTurnBuiltInTools(
  offeredTools: readonly TurnBuiltInTool[],
  canUseTools: boolean,
  attachments: readonly ReadableAttachment[],
  readAttachmentFile: ReadAttachmentFile
): readonly TurnBuiltInTool[] {
  if (!canUseTools || !hasReadableTextAttachment(attachments))
    return offeredTools
  return [
    ...offeredTools,
    {
      definition: buildReadAttachmentDefinition(),
      tool: new ReadAttachmentTool(attachments, readAttachmentFile),
      runsWithoutApproval: true
    }
  ]
}

/**
 * Starts the generation that writes one stored turn's reply and, for an
 * untitled conversation, its title unless another turn of that conversation
 * is already generating one.
 *
 * @param input - Stored turn and the request values its tasks keep.
 * @returns The registered generation.
 * @throws If the registry no longer admits generations; the stored reply is
 * finalized as interrupted first, so no reply stays streaming.
 */
function startTurnGeneration(input: TurnGenerationInput): ReplyGeneration {
  const { turn, dependencies, logger } = input
  const target = {
    conversationId: turn.conversation.id,
    assistantMessageId: turn.assistantMessage.id
  }
  try {
    return dependencies.generations.startReplyGeneration(target, {
      startReplyTask: (context) => createTurnReplyTask(input, context),
      startTitleTask:
        turn.conversation.title === null
          ? (context) => createTurnTitleTask(input, context)
          : undefined,
      reportTaskFailure: (error) => {
        logger.error({ err: error }, "Conversation task failed")
      }
    })
  } catch (error) {
    dependencies.turns.updateAssistantMessageState(turn.assistantMessage.id, {
      status: "interrupted"
    })
    throw error
  }
}

/**
 * Has the turn's agent write its reply, then finalizes a reply it left
 * streaming.
 *
 * @param input - Stored turn, its agent, and the request values the reply
 * keeps.
 * @param context - Generation-owned cancellation, event sender, tool call
 * sender, and approval prompt sender.
 * @returns Settlement after the reply is final.
 * @throws The agent's failure after the fallback finalization; an
 * `AggregateError` of the agent's failure and the fallback's failure when the
 * fallback also fails; or the fallback's failure after an agent that
 * succeeded. The generation reports it.
 * @remarks The fallback stores `interrupted` after cancellation and `failed`
 * otherwise; it changes nothing when the agent already finalized the reply.
 */
async function createTurnReplyTask(
  input: TurnGenerationInput,
  context: ReplyTaskContext
): Promise<void> {
  const { turn, dependencies } = input
  const { abortSignal } = context
  const assistantMessageId = turn.assistantMessage.id
  try {
    await input.agent.createReply(buildAgentTurn(input, context))
  } catch (taskError) {
    try {
      updateUnfinishedReplyState(
        dependencies.turns,
        assistantMessageId,
        abortSignal
      )
    } catch (finalizationError) {
      throw new AggregateError(
        [taskError, finalizationError],
        "Reply failure could not be finalized",
        { cause: finalizationError }
      )
    }
    throw taskError
  }
  updateUnfinishedReplyState(
    dependencies.turns,
    assistantMessageId,
    abortSignal
  )
}

/**
 * Builds the turn the agent answers for one stored turn.
 *
 * @param input - Stored turn, its tools, and the request values the reply
 * keeps.
 * @param context - Generation-owned cancellation, event sender, tool call
 * sender, and approval prompt sender.
 * @returns The agent turn, whose parts and final state go to the stored
 * reply, which numbers new sources after the conversation's stored ones,
 * whose tool calls pass the approval gateway, and whose images are read
 * from the conversation's attachment files. With the request's logger, an
 * unreadable settings file is logged as a warning; a cancelled reply, and a
 * round that was not sent because it did not fit or its model was not
 * loaded, at debug level; and any other reply failure as an error.
 */
function buildAgentTurn(
  input: TurnGenerationInput,
  {
    abortSignal,
    sendEvent,
    sendClientToolCall,
    sendToolApprovalPrompt
  }: ReplyTaskContext
): AgentTurn {
  const { turn, dependencies } = input
  const { replyParts } = dependencies
  const assistantMessageId = turn.assistantMessage.id
  return {
    history: turn.conversation.messages,
    sources: turn.conversation.sources,
    userMessage: turn.userMessage,
    canSeeImages: input.canSeeImages,
    findAttachmentImage: input.findAttachmentImage,
    model: input.model,
    generationOptions: input.generationOptions,
    clientTools: input.clientTools,
    builtInTools: input.builtInTools,
    abortSignal,
    createReplyPart: (draft) =>
      replyParts.createReplyPart(assistantMessageId, draft),
    updateReplyPartContent: (partId, content) =>
      replyParts.updateReplyPartContent(assistantMessageId, partId, content),
    updateReplyToolCall: (toolCallId, change) =>
      replyParts.updateReplyToolCall(assistantMessageId, toolCallId, change),
    updateAssistantMessageState: (completion) =>
      dependencies.turns.updateAssistantMessageState(
        assistantMessageId,
        completion
      ),
    sendEvent,
    sendClientToolCall,
    createToolCallGate: () =>
      dependencies.toolApprovals.createToolCallGate(
        sendToolApprovalPrompt,
        () => {
          input.logger.warn(UNREADABLE_JUST_RUN_CHOICES_MESSAGE)
        }
      ),
    reportReplyCancellation: (failure) => {
      input.logger.debug({ err: failure }, "Chat completion was cancelled")
    },
    reportReplyRefusal: (failure) => {
      input.logger.debug(
        { err: failure },
        "Chat round was not sent to the model"
      )
    },
    reportReplyFailure: (failure) => {
      input.logger.error({ err: failure }, "Chat completion stream failed")
    }
  }
}

/**
 * Stores a final state for a reply its task left streaming.
 *
 * @param turns - Turn persistence borrowed for the route lifetime.
 * @param assistantMessageId - UUIDv7 of the reply.
 * @param abortSignal - The reply task's cancellation; aborted means the reply
 * was stopped or shut down.
 * @throws If the state cannot be stored.
 * @remarks Stores `interrupted` after cancellation and `failed` otherwise. A
 * reply that is already final, superseded, or deleted is left unchanged.
 */
function updateUnfinishedReplyState(
  turns: ConversationTurnWriter,
  assistantMessageId: string,
  abortSignal: AbortSignal
): void {
  turns.updateAssistantMessageState(assistantMessageId, {
    status: abortSignal.aborted ? "interrupted" : "failed"
  })
}

/**
 * Runs one turn's title task for a conversation without a stored title.
 *
 * @param input - Stored turn and the request values the task keeps.
 * @param context - Generation-owned cancellation and event sender.
 * @returns Settlement after the title is sent or its outcome is logged; it
 * does not reject.
 */
function createTurnTitleTask(
  input: TurnGenerationInput,
  { abortSignal, sendEvent }: ReplyGenerationTaskContext
): Promise<void> {
  const { turn, dependencies } = input
  return createTitleGenerationTask({
    generateTitle: dependencies.generateTitle,
    findLoadedContextLength: dependencies.findLoadedContextLength,
    userMessageContent: turn.userMessage.content,
    model: input.model,
    abortSignal,
    sendEvent,
    logger: input.logger,
    titleGenerationMaxAttempts: dependencies.titleGenerationMaxAttempts,
    updateConversationTitle: (title) =>
      dependencies.titleWriter.updateGeneratedConversationTitle(
        turn.conversation.id,
        title
      )
  })
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
    const { id, title, agentCode, createdAt, updatedAt } = turn.conversation
    const conversation = { id, title, agentCode, createdAt, updatedAt }
    return [
      {
        type: "start-new-conversation-turn",
        conversation,
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
