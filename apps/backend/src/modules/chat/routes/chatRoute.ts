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
import { buildAttachmentImageReader } from "../../attachment/attachmentImageReader"
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
  ConversationTurnWriter,
  CreateConversationTurnOptions,
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
  findListedModelCapabilities,
  NO_MODEL_CAPABILITIES,
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
  type TurnAgentLookups,
  type UnansweredTurnOutcome
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
  | "saveMessageAttachments"
  | "deleteMessageAttachments"
  | "deleteConversationAttachments"
  | "readAttachment"
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
     * Saves each turn's attachment files, deletes them when the turn is not
     * stored, and reads stored ones.
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
    /**
     * Approval gateway every tool call passes, except a call of a backend
     * tool that runs without approval.
     */
    toolApprovals: ToolApprovalService
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
  /** Backend tools the request offered, found for the turn. */
  builtInTools: readonly TurnBuiltInTool[]
  /**
   * What the model can do with attachments; both false when neither the
   * request nor the conversation holds any.
   */
  capabilities: ModelCapabilities
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
type SavedTurnOutcome = SavedTurn | UnansweredTurnOutcome

/** What the generation input of a stored turn is built from. */
type TurnGenerationSource = Readonly<{
  /** Validated chat input and request logger. */
  request: ChatRouteRequest
  /** What the request parsed and looked up before the turn was stored. */
  accepted: AcceptedTurnRequest
  /** The stored turn and the agent that answers it. */
  saved: SavedTurn
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
      app.llmService.listDownloadedLlmModels()
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
 * key saved or removed while it runs applies from the next request.
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
  const generation = startTurnGeneration(
    buildTurnGenerationInput({ request, accepted, saved }, dependencies)
  )
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
 * offered backend tool that cannot run now, the problem that says why no
 * agent answers, or the image-needs-vision problem for an image attached
 * for a model that cannot see images, including a model the inventory does
 * not list. Nothing is stored or written either way.
 * @throws An `UnknownBackendToolError` for an offered backend tool the
 * backend does not run; the inventory read's failure; and any persistence
 * failure of a lookup.
 * @remarks The attachments are decoded first, then every offered backend
 * tool is looked up, then the conversation is read once and an agent is
 * looked up for the request, so a request no agent answers is refused
 * before the inventory is read; the conversation's stored attachments come
 * from that read. The model's capabilities are read from LM Studio only when
 * the request or the conversation holds an attachment, so a turn without any
 * never waits for the model-operation queue. The agent found here is not
 * kept: the lookup that decides who answers runs again when the turn is
 * stored.
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
  const builtInTools = await findOfferedBuiltInTools(
    request,
    reply,
    dependencies.builtInTools
  )
  if (builtInTools === undefined) return undefined
  const checked = findTurnConversation(request, reply, dependencies)
  if (checked === undefined) return undefined
  const capabilities = hasTurnAttachments(
    checked.storedConversation,
    attachments.attachments
  )
    ? await findListedModelCapabilities(
        body.model,
        dependencies.findModelCapabilities
      )
    : NO_MODEL_CAPABILITIES
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
  return { attachments: attachments.attachments, builtInTools, capabilities }
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
 * sent.
 * @throws Any persistence failure of a lookup.
 * @remarks The conversation is read once, here; the agent lookup uses that
 * read, and the caller takes the stored attachments from it. The agent is
 * not returned, because it is looked up again when the turn is stored.
 */
function findTurnConversation(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: Pick<
    ChatRouteDependencies,
    "findChatAgent" | "findConversation"
  >
): CheckedTurnConversation | undefined {
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
  return { storedConversation }
}

/**
 * Finds the backend tools a request offers for its turn, or answers the
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
async function findOfferedBuiltInTools(
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
    "turns" | "attachmentFiles" | "findChatAgent" | "findConversation"
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
 * before the turn commits, and the attachments' drafts in request order.
 */
function buildTurnOptions(
  body: ChatApiRequestBody,
  attachments: readonly ParsedChatAttachment[]
): CreateConversationTurnOptions {
  return {
    conversation:
      body.conversation.kind === "new"
        ? { kind: "new", id: uuidv7(), agentCode: body.conversation.agentCode }
        : body.conversation,
    userMessage: {
      id: uuidv7(),
      content: body.message,
      attachments: attachments.map((attachment) => attachment.draft)
    },
    model: body.model
  }
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
    "turns" | "findChatAgent" | "findConversation"
  >
): SavedTurnOutcome {
  const requestedAgent = findRequestedAgent(requested, {
    findChatAgent: dependencies.findChatAgent,
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
 * Builds the values a stored turn's tasks keep.
 *
 * @param source - The request, what it parsed and looked up, and the stored
 * turn with its agent.
 * @param dependencies - Route capabilities borrowed for the route lifetime.
 * @returns The turn with its agent, request values, the backend tools of the
 * turn, which are the offered ones followed by the attachment reader as
 * {@link buildTurnBuiltInTools} adds it for a model trained for tool use,
 * whether the model sees images, and the reader of the conversation's
 * stored images.
 */
function buildTurnGenerationInput(
  source: TurnGenerationSource,
  dependencies: ChatRouteDependencies
): TurnGenerationInput {
  const { request, accepted, saved } = source
  const { body } = request
  const { turn } = saved
  const { attachmentFiles } = dependencies
  const conversationId = turn.conversation.id
  return {
    turn,
    agent: saved.agent,
    model: body.model,
    generationOptions: body.generationOptions,
    clientTools: body.tools?.definitions ?? NO_REQUESTED_TOOLS,
    builtInTools: accepted.capabilities.trainedForToolUse
      ? buildTurnBuiltInTools(
          accepted.builtInTools,
          listReadableAttachments(conversationId, [
            ...turn.conversation.messages,
            turn.userMessage
          ]),
          (location) => attachmentFiles.readAttachment(location)
        )
      : accepted.builtInTools,
    canSeeImages: accepted.capabilities.vision,
    findAttachmentImage: buildAttachmentImageReader(
      conversationId,
      attachmentFiles
    ),
    logger: request.log,
    dependencies
  }
}

/**
 * Builds the backend tools of a turn whose model is trained for tool use.
 *
 * @param offeredTools - Backend tools the request offered, found for the
 * turn.
 * @param attachments - Every attachment of the conversation, the new
 * message's included.
 * @param readAttachmentFile - Reads an attachment's file; lent for the turn.
 * @returns The offered tools, followed by the attachment reader when an
 * attachment is a text file; the reader's calls run without approval, as
 * they read only what the person attached to this conversation. A model
 * that is not trained for tool use gets the offered tools alone, without a
 * call here.
 */
function buildTurnBuiltInTools(
  offeredTools: readonly TurnBuiltInTool[],
  attachments: readonly ReadableAttachment[],
  readAttachmentFile: ReadAttachmentFile
): readonly TurnBuiltInTool[] {
  if (!hasReadableTextAttachment(attachments)) return offeredTools
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
