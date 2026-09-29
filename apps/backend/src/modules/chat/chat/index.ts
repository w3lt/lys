import {
  chatApi,
  type ChatApiRoute,
  type ChatApiStreamEvent,
  type MessageGenerationOptions
} from "@lys/protocol"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import type { BackendConfig } from "../../../config"
import type {
  CompleteChatOptions,
  TitleGenerationOptions
} from "../../../di/services/chatService"
import type { ConversationTurn } from "../../../di/services/conversationService/share"
import { ConversationNotFoundError } from "../../../utils/errors"
import { createConversationNotFoundProblem } from "../../conversation/notFound"
import createChatTask, { type CreateChatTaskOptions } from "./chatTask"
import { buildChatMessages } from "./messages"
import type {
  ConversationTurnWriter,
  GeneratedConversationTitleWriter
} from "./persistence"
import ReplyEventSubscription from "./replyEventSubscription"
import type ReplyGeneration from "./replyGeneration"
import type { ReplyGenerationTaskContext } from "./replyGeneration"
import type ReplyGenerationRegistry from "./replyGenerationRegistry"
import {
  createEventSender,
  openReplyEventStream,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"
import createTitleGenerationTask from "./titleGenerationTask"

/** Backend settings the chat route applies to every request. */
export type ChatRouteOptions = Pick<
  BackendConfig,
  "lysSystemPrompt" | "titleGenerationMaxAttempts"
>

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
  /** Bound application inference operation; no adapter cleanup authority. */
  completeChatStream: CreateChatTaskOptions["completeChatStream"]
  /** Bound title operation retained separately from chat completion. */
  generateTitle: (options: TitleGenerationOptions) => Promise<string>
  /** Startup-loaded prompt persisted with a conversation this route creates. */
  lysSystemPrompt: string
  /** Inclusive maximum number of title requests permitted for one turn. */
  titleGenerationMaxAttempts: number
  /** Registry that owns every generation this route starts. */
  generations: ReplyGenerationRegistry
}>

/** Values one turn's tasks keep after the request that started them ended. */
type TurnGenerationInput = Readonly<{
  /** Stored turn and prior transcript snapshot. */
  turn: ConversationTurn
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
 * @param registration - System prompt, title attempt limit, and the registry
 * that owns the started generations.
 * @returns Settlement after route registration.
 * @throws If borrowed access or route registration fails.
 */
export default async function updateFastifyWithChatRoute(
  app: FastifyInstance,
  {
    lysSystemPrompt,
    titleGenerationMaxAttempts,
    generations
  }: ChatRouteRegistration
): Promise<void> {
  const turns = app.conversationService.createTurnAccess()
  const dependencies = {
    turns,
    titleWriter: turns,
    completeChatStream: (options: CompleteChatOptions) =>
      app.chatService.completeChatStream(options),
    generateTitle: (options: TitleGenerationOptions) =>
      app.chatService.generateTitle(options),
    lysSystemPrompt,
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
 * @param dependencies - Borrowed persistence, inference, and registry.
 * @returns Settlement after the stream ends, or after the missing-conversation
 * response.
 * @throws Unexpected failures before the stream starts, for Fastify's HTTP
 * error boundary.
 * @remarks Closing this stream does not cancel the generation. The turn, the
 * generation, and this follower are created in one synchronous step, so the
 * follower receives the start event before any generation event.
 */
async function handleChatRequest(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: ChatRouteDependencies
): Promise<void> {
  const turn = createRequestedTurn(request, reply, dependencies)
  if (turn === undefined) return

  const generation = startTurnGeneration({
    turn,
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
 * @param dependencies - Borrowed turn persistence and system prompt.
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
      systemPrompt: dependencies.lysSystemPrompt
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
 * Starts the generation that writes one stored turn's reply and, for an
 * untitled conversation, its title.
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
 * Runs one turn's reply task and finalizes a reply it left streaming.
 *
 * @param input - Stored turn and the request values the task keeps.
 * @param context - Generation-owned cancellation and event sender.
 * @returns Settlement after the reply is final.
 * @throws The task's failure after the fallback finalization; an
 * `AggregateError` of the task's failure and the fallback's failure when the
 * fallback also fails; or the fallback's failure after a task that succeeded.
 * The generation reports it.
 * @remarks The fallback stores `interrupted` after cancellation and `failed`
 * otherwise; it changes nothing when the task already finalized the reply.
 */
async function createTurnReplyTask(
  input: TurnGenerationInput,
  { abortSignal, sendEvent }: ReplyGenerationTaskContext
): Promise<void> {
  const { turn, dependencies } = input
  const assistantMessageId = turn.assistantMessage.id
  try {
    await createChatTask({
      completeChatStream: dependencies.completeChatStream,
      updateAssistantMessageState: (completion) =>
        dependencies.turns.updateAssistantMessageState(
          assistantMessageId,
          completion
        ),
      updateAssistantMessageContent: (content) =>
        dependencies.turns.updateAssistantMessageContent(
          assistantMessageId,
          content
        ),
      messages: buildChatMessages(turn),
      model: input.model,
      generationOptions: input.generationOptions,
      abortSignal,
      sendEvent,
      logger: input.logger
    })
  } catch (taskFailure) {
    try {
      updateUnfinishedReplyState(
        dependencies.turns,
        assistantMessageId,
        abortSignal
      )
    } catch (finalizationFailure) {
      throw new AggregateError(
        [taskFailure, finalizationFailure],
        "Reply failure could not be finalized",
        { cause: finalizationFailure }
      )
    }
    throw taskFailure
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
    const { id, title, systemPrompt, createdAt, updatedAt } = turn.conversation
    const conversation = { id, title, systemPrompt, createdAt, updatedAt }
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
