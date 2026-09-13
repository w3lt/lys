import { chatApi, type ChatApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import {
  createAbortSignal,
  createEventSender,
  type ChatRouteRequest,
  type ChatRouteReply
} from "./share"
import createChatTask from "./chatTask"
import createTitleGenerationTask from "./titleGenerationTask"
import { buildChatMessages } from "./messages"
import { ConversationNotFoundError } from "../../../utils/errors"
import { createConversationNotFoundProblem } from "../../conversation/notFound"
import type {
  ConversationTurnWriter,
  GeneratedConversationTitleWriter
} from "./persistence"
import type { ConversationTurn } from "../../../di/services/conversationService/share"
import type {
  CompleteChatOptions,
  TitleGenerationOptions
} from "../../../di/services/chatService"
import type { CreateChatTaskOptions } from "./chatTask"
import { ChatRequestLifetime } from "./requestLifetime"

/** Dependencies borrowed for the lifetime of a registered chat route. */
type ChatRouteDependencies = Readonly<{
  /** Turn persistence whose lifetime outlives all active route handlers. */
  turns: ConversationTurnWriter
  /** Conditional generated-title persistence borrowed for the route lifetime. */
  titleWriter: GeneratedConversationTitleWriter
  /** Bound application inference operation; no adapter cleanup authority. */
  completeChatStream: CreateChatTaskOptions["completeChatStream"]
  /** Bound title operation retained separately from chat completion. */
  generateTitle: (options: TitleGenerationOptions) => Promise<string>
}>

/**
 * Installs the chat endpoint, persisting turns before opening their event streams.
 * @param app - Backend with SSE, validation, and singleton services installed.
 * @returns Settlement after route registration.
 * @throws If borrowed access or route registration fails.
 */
export default async function updateFastifyWithChatRoute(
  app: FastifyInstance
): Promise<void> {
  const lifetime = new ChatRequestLifetime()
  app.addHook("onClose", () => lifetime[Symbol.asyncDispose]())
  const turns = app.conversationService.createTurnAccess()
  const dependencies = {
    turns,
    titleWriter: turns,
    completeChatStream: (options: CompleteChatOptions) =>
      app.chatService.completeChatStream(options),
    generateTitle: (options: TitleGenerationOptions) =>
      app.chatService.generateTitle(options)
  }
  app.route<ChatApiRoute>({
    method: chatApi.method,
    url: chatApi.path,
    sse: "only",
    schema: { body: chatApi.body },
    handler: async (request, reply) =>
      lifetime.createRequestTask(() =>
        handleChatRequest(request, reply, dependencies)
      )
  })
}

/**
 * Selects a conversation and owns both generation tasks through settlement.
 * @param request - Validated chat input and request logger.
 * @param reply - SSE or pre-stream error response owner.
 * @param dependencies - Borrowed persistence and inference capabilities.
 * @returns Settlement after both tasks, or the missing-conversation response.
 * @throws Unexpected pre-stream construction errors for Fastify's HTTP error boundary.
 */
async function handleChatRequest(
  request: ChatRouteRequest,
  reply: ChatRouteReply,
  dependencies: ChatRouteDependencies
): Promise<void> {
  try {
    const turn = dependencies.turns.createConversationTurn({
      model: request.body.model,
      conversationId: request.body.conversationId,
      userMessageContent: request.body.message
    })
    await createConversationStream({ request, reply, dependencies, turn })
  } catch (error) {
    if (reply.raw.headersSent || reply.raw.destroyed) {
      request.log.error(
        { err: error },
        "Conversation stream finalization failed"
      )
      if (reply.sse.isConnected) reply.sse.close()
      return
    }
    if (
      error instanceof ConversationNotFoundError &&
      request.body.conversationId !== undefined
    ) {
      reply
        .type("application/problem+json")
        .code(404)
        .send(
          createConversationNotFoundProblem(
            request.body.conversationId,
            request.url
          )
        )
      return
    }
    throw error
  }
}

/** Turn and request ownership needed until both stream tasks have settled. */
type ConversationStreamOptions = Readonly<{
  /** Current validated request. */
  request: ChatRouteRequest
  /** Connection whose closure cancels generation. */
  reply: ChatRouteReply
  /** Borrowed persistence and model adapters. */
  dependencies: ChatRouteDependencies
  /** Atomically persisted turn and prior transcript snapshot. */
  turn: ConversationTurn
}>

/**
 * Publishes the committed turn and joins chat and optional title generation.
 * @param options - Request lifecycle and turn-specific write authority.
 * @returns Settlement after every task and fallback assistant finalization.
 * @throws If initial publication or terminal persistence fails.
 */
async function createConversationStream(
  options: ConversationStreamOptions
): Promise<void> {
  const { request, reply, dependencies, turn } = options
  const abortSignal = createAbortSignal(reply)
  try {
    await createConversationStartEvent(reply, turn)
    const tasks = createConversationTasks(options, abortSignal)
    const outcomes = await Promise.allSettled(tasks)
    for (const outcome of outcomes) {
      if (outcome.status === "rejected")
        request.log.error({ err: outcome.reason }, "Conversation task failed")
    }
  } finally {
    dependencies.turns.updateAssistantMessageState(turn.assistantMessage.id, {
      status: abortSignal.aborted ? "interrupted" : "failed"
    })
  }
}

/**
 * Starts model work only after the turn-start event has been accepted.
 * @param options - Turn and borrowed model/persistence dependencies.
 * @param abortSignal - Cancellation owned by the request connection.
 * @returns Both owned tasks; title generation is absent for already titled conversations.
 */
function createConversationTasks(
  options: ConversationStreamOptions,
  abortSignal: AbortSignal
): Promise<void>[] {
  const { dependencies, turn, request, reply } = options
  const tasks = [
    createChatTask({
      completeChatStream: dependencies.completeChatStream,
      model: request.body.model,
      messages: buildChatMessages(turn),
      generationOptions: request.body.generationOptions,
      abortSignal,
      reply,
      request,
      updateAssistantMessageContent: (content) =>
        dependencies.turns.updateAssistantMessageContent(
          turn.assistantMessage.id,
          content
        ),
      updateAssistantMessageState: (completion) =>
        dependencies.turns.updateAssistantMessageState(
          turn.assistantMessage.id,
          completion
        )
    })
  ]
  if (turn.conversation.title === null) {
    tasks.push(
      createTitleGenerationTask({
        generateTitle: dependencies.generateTitle,
        model: request.body.model,
        userMessageContent: turn.userMessage.content,
        abortSignal,
        reply,
        request,
        updateConversationTitle: (title) =>
          dependencies.titleWriter.updateGeneratedConversationTitle(
            turn.conversation.id,
            title
          )
      })
    )
  }
  return tasks
}

/**
 * Announces a committed turn before any chat or title generation event.
 * @param reply - Active SSE output.
 * @param turn - Persisted pair and conversation snapshot.
 * @returns Settlement after the initial event is accepted by the transport.
 * @throws If the connection cannot accept the start event.
 */
async function createConversationStartEvent(
  reply: ChatRouteReply,
  turn: ConversationTurn
): Promise<void> {
  const sendEvent = createEventSender(reply)
  const pair = {
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage
  }
  if (turn.isNewConversation) {
    const { id, title, systemPrompt, createdAt, updatedAt } = turn.conversation
    await sendEvent({
      type: "start-new-conversation-turn",
      conversation: { id, title, systemPrompt, createdAt, updatedAt },
      ...pair
    })
    return
  }
  await sendEvent({ type: "start-existing-conversation-turn", ...pair })
}
