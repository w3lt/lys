import {
  chatApi,
  type ChatApiRoute,
  type ChatApiStreamEvent,
  type MessageGenerationOptions
} from "@lys/protocol"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import type { BackendConfig } from "../../../config"
import type Agent from "../../agent/agent"
import type AgentRoster from "../../agent/roster"
import type { TitleGenerationOptions } from "../chatService"
import { ConversationNotFoundError } from "../../../utils/errors"
import { createConversationNotFoundProblem } from "../../conversation/routes/notFound"
import type {
  ConversationTurn,
  ConversationTurnWriter,
  GeneratedConversationTitleWriter
} from "../persistence"
import ReplyEventSubscription from "../replyEventSubscription"
import type ReplyGeneration from "../replyGeneration"
import type { ReplyGenerationTaskContext } from "../replyGeneration"
import type ReplyGenerationRegistry from "../replyGenerationRegistry"
import {
  createEventSender,
  openReplyEventStream,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"
import createTitleGenerationTask from "../titleGenerationTask"

/** Backend settings the chat route applies to every request. */
export type ChatRouteOptions = Pick<BackendConfig, "titleGenerationMaxAttempts">

/** Settings and the generation registry the chat route is installed with. */
export type ChatRouteRegistration = ChatRouteOptions &
  Readonly<{
    /** Registry owning every generation this route starts; not disposed here. */
    generations: ReplyGenerationRegistry
  }>

/** Capabilities and settings borrowed for the lifetime of a registered chat route. */
type ChatRouteDependencies = Readonly<{
  /** Turn persistence whose lifetime outlives all active generations. */
  turns: ConversationTurnWriter
  /** Conditional generated-title persistence borrowed for the route lifetime. */
  titleWriter: GeneratedConversationTitleWriter
  /** Agents that answer turns, borrowed for the route lifetime. */
  agentRoster: AgentRoster
  /** Bound title operation retained separately from chat completion. */
  generateTitle: (options: TitleGenerationOptions) => Promise<string>
  /** Inclusive maximum number of title requests permitted for one turn. */
  titleGenerationMaxAttempts: number
  /** Registry that owns every generation this route starts. */
  generations: ReplyGenerationRegistry
}>

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
    titleWriter: turns,
    agentRoster: app.agentRoster,
    generateTitle: (options: TitleGenerationOptions) =>
      app.chatService.generateTitle(options),
    titleGenerationMaxAttempts,
    generations
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
 * @returns Settlement after the stream ends, or after the missing-conversation
 * response.
 * @throws Unexpected failures before the stream starts, for Fastify's HTTP
 * error boundary.
 * @remarks Closing this stream does not cancel the generation. The turn, the
 * generation, and this follower are created in one synchronous step, so the
 * follower receives the start event before any generation event. A
 * conversation whose agent is not available fails the request before the
 * stream starts.
 */
async function handleChatRequest(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: ChatRouteDependencies
): Promise<void> {
  const turn = createRequestedTurn(request, reply, dependencies)
  if (turn === undefined) return
  const agent = dependencies.agentRoster.findAgent(turn.conversation.agentCode)
  if (agent === undefined) rejectTurnWithoutAgent(turn, dependencies.turns)

  const generation = startTurnGeneration({
    turn,
    agent,
    model: request.body.model,
    generationOptions: request.body.generationOptions,
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
 * Stores the requested turn, or answers that its conversation is not stored.
 *
 * @param request - Validated chat input.
 * @param reply - Response owner used only for the missing-conversation answer.
 * @param dependencies - Borrowed turn persistence and agents; a new
 * conversation gets the default agent.
 * @returns The stored turn, or undefined after the missing-conversation
 * problem was sent.
 * @throws Any other persistence failure; nothing was stored.
 */
function createRequestedTurn(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: ChatRouteDependencies
): ConversationTurn | undefined {
  const { conversationId } = request.body
  try {
    return dependencies.turns.createConversationTurn({
      model: request.body.model,
      conversationId,
      userMessageContent: request.body.message,
      agentCode: dependencies.agentRoster.getDefaultAgent().code
    })
  } catch (error) {
    if (
      !(error instanceof ConversationNotFoundError) ||
      conversationId === undefined
    )
      throw error
    reply
      .type("application/problem+json")
      .code(404)
      .send(createConversationNotFoundProblem(conversationId, request.url))
    return undefined
  }
}

/**
 * Rejects a stored turn whose conversation's agent is not available, storing
 * its reply as failed so it does not stay streaming.
 *
 * @param turn - Stored turn whose reply is still streaming.
 * @param turns - Turn persistence borrowed for the route lifetime.
 * @throws Always: `Conversation agent <code> is not available` after the
 * reply was stored as failed, or an `AggregateError` holding that error
 * followed by the persistence failure when the failed state cannot be stored.
 */
function rejectTurnWithoutAgent(
  turn: ConversationTurn,
  turns: ConversationTurnWriter
): never {
  const missingAgent = new Error(
    `Conversation agent ${turn.conversation.agentCode} is not available`
  )
  try {
    turns.updateAssistantMessageState(turn.assistantMessage.id, {
      status: "failed"
    })
  } catch (persistenceError) {
    throw new AggregateError(
      [missingAgent, persistenceError],
      "Missing agent failure could not be finalized",
      { cause: persistenceError }
    )
  }
  throw missingAgent
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
 * @param context - Generation-owned cancellation and event sender.
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
  { abortSignal, sendEvent }: ReplyGenerationTaskContext
): Promise<void> {
  const { turn, dependencies } = input
  const assistantMessageId = turn.assistantMessage.id
  try {
    await input.agent.createReply({
      history: turn.conversation.messages,
      userMessageContent: turn.userMessage.content,
      model: input.model,
      generationOptions: input.generationOptions,
      abortSignal,
      updateAssistantMessageContent: (content) =>
        dependencies.turns.updateAssistantMessageContent(
          assistantMessageId,
          content
        ),
      updateAssistantMessageState: (completion) =>
        dependencies.turns.updateAssistantMessageState(
          assistantMessageId,
          completion
        ),
      sendEvent,
      reportReplyCancellation: (failure) => {
        input.logger.debug({ err: failure }, "Chat completion was cancelled")
      },
      reportReplyFailure: (failure) => {
        input.logger.error({ err: failure }, "Chat completion stream failed")
      }
    })
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
