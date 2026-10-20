import {
  chatApi,
  type ChatApiRoute,
  type ChatApiStreamEvent,
  type MessageGenerationOptions
} from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import type { BackendConfig } from "../../../config"
import type Agent from "../../agent/agent"
import type { AgentTurn } from "../../agent/agent"
import type {
  BuiltInToolEntry,
  TurnBuiltInTool
} from "../../tool/builtIn/builtInTool"
import {
  findTurnBuiltInTools,
  type TurnToolSetLookup
} from "../../tool/builtIn/builtInTools"
import type ToolApprovalService from "../../toolApproval/toolApprovalService"
import type { TitleGenerationOptions } from "../chatService"
import type {
  ConversationTurn,
  ConversationTurnWriter,
  GeneratedConversationTitleWriter,
  ReplyPartWriter
} from "../persistence"
import ReplyEventSubscription from "../replyEventSubscription"
import { createChatBackendToolUnavailableProblem } from "./replyProblems"
import type ReplyGeneration from "../replyGeneration"
import type {
  ReplyGenerationTaskContext,
  ReplyTaskContext
} from "../replyGeneration"
import type ReplyGenerationRegistry from "../replyGenerationRegistry"
import {
  createEventSender,
  openReplyEventStream,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"
import createTitleGenerationTask from "../titleGenerationTask"
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

/**
 * Capabilities and settings borrowed for the lifetime of a registered chat
 * route, including the agent lookups.
 */
type ChatRouteDependencies = TurnAgentLookups &
  Readonly<{
    /** Turn persistence whose lifetime outlives all active generations. */
    turns: ConversationTurnWriter
    /** Reply-part persistence whose lifetime outlives all active generations. */
    replyParts: ReplyPartWriter
    /** Conditional generated-title persistence borrowed for the route lifetime. */
    titleWriter: GeneratedConversationTitleWriter
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
  /** Backend tools found for the turn, each name once; empty when it offered none. */
  builtInTools: readonly TurnBuiltInTool[]
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
    findConversationAgentCode: (conversationId: string) =>
      app.conversationHistoryReader.getConversation(conversationId)?.agentCode,
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
    sse: "only",
    schema: { body: chatApi.body },
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
 * @param dependencies - Borrowed persistence, agents, and registry.
 * @returns Settlement after the stream ends, or after a problem response.
 * @throws An `UnknownBackendToolError`, before anything is stored,
 * when the request offers a backend tool the backend does not run; and
 * unexpected failures before the stream starts, for Fastify's HTTP error
 * boundary. An offered backend tool that cannot run now is answered with a
 * 409 problem, before anything is stored.
 * @remarks Closing this stream does not cancel the generation. The agent is
 * found before the turn is stored, and the turn, the generation, and this
 * follower are created in the same synchronous step, so no agent, turn, or
 * conversation changes in between and the follower receives the start event
 * before any generation event. The agent stored with the turn's conversation
 * answers it, with the system prompt it has when the turn starts. Every
 * offered backend tool is looked up before the agent is found; the turn keeps
 * those tools, so a key saved or removed while it runs applies from
 * the next request.
 */
async function handleChatRequest(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: ChatRouteDependencies
): Promise<void> {
  const offeredBuiltInTools = findRequestedBuiltInTools(
    dependencies.builtInTools,
    request.body.tools
  )
  const builtInTools = await findTurnBuiltInTools(offeredBuiltInTools)
  if (builtInTools.status === "unavailable") {
    sendBackendToolUnavailableProblem(reply, builtInTools, request.url)
    return
  }
  const requestedAgent = findRequestedAgent(
    request.body.conversation,
    dependencies
  )
  if (requestedAgent.status !== "found") {
    sendUnansweredTurnProblem(reply, requestedAgent, request.url)
    return
  }
  const turn = dependencies.turns.createConversationTurn({
    conversation: request.body.conversation,
    userMessageContent: request.body.message,
    model: request.body.model
  })

  const generation = startTurnGeneration({
    turn,
    agent: requestedAgent.agent,
    model: request.body.model,
    generationOptions: request.body.generationOptions,
    clientTools: request.body.tools?.definitions ?? NO_REQUESTED_TOOLS,
    builtInTools: builtInTools.tools,
    logger: request.log,
    dependencies
  })
  const subscription = new ReplyEventSubscription<ChatApiStreamEvent>(
    createEventSender<ChatApiStreamEvent>(reply.sse)
  )
  for (const event of buildTurnStartEvents(turn))
    subscription.handleStreamEvent(event)
  generation.openSubscription(subscription)
  await openReplyEventStream(reply.sse, subscription)
}

/**
 * Sends the problem response for an offered backend tool that cannot run now.
 *
 * @param reply - Response owner; the response has not started.
 * @param lookup - Lookup naming the tool and why it cannot run.
 * @param instance - Request path identifying this occurrence.
 */
function sendBackendToolUnavailableProblem(
  reply: ChatRouteReply,
  lookup: Extract<TurnToolSetLookup, { status: "unavailable" }>,
  instance: string
): void {
  const problem = createChatBackendToolUnavailableProblem(
    lookup.toolName,
    lookup.reason,
    instance
  )
  reply.type("application/problem+json").code(problem.status).send(problem)
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
 * reply, which numbers new sources after the conversation's stored ones, and
 * whose tool calls pass the approval gateway. With the request's logger, an
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
    userMessageContent: turn.userMessage.content,
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
