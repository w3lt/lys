import {
  chatApi,
  type ChatApiRequestBody,
  type ChatApiRoute
} from "@lys/protocol"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import {
  createAbortSignal,
  createEventSender,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"
import ConversationTurn from "./conversationTurn"
import createChatTask from "./chatTask"
import createTitleGenerationTask, {
  type CreateTitleGenerationTaskOptions
} from "./titleGenerationTask"
import { ConversationNotFoundError } from "../../../utils/errors"
import type ConversationService from "../../../di/services/conversationService"
import type ChatService from "../../../di/services/chatService"
import type { BackendConfig } from "../../../config"

/** Backend settings the chat route applies to every request. */
export type ChatRouteOptions = Pick<
  BackendConfig,
  "lysSystemPrompt" | "titleGenerationMaxAttempts"
>

/** Title-task inputs supplied by the route; the turn supplies its message and title persistence. */
type UntitledConversationTitleTaskOptions = Omit<
  CreateTitleGenerationTaskOptions,
  "userMessageContent" | "updateConversationTitle"
>

/** Route-owned inputs used to start and settle one turn's generation tasks. */
type ConversationTaskStartOptions = {
  /** Shared signal aborted when the request's SSE connection closes. */
  abortSignal: AbortSignal
  /** Application-scoped service used for chat and title generation. */
  chatService: ChatService
  /** Store used for assistant-state and title persistence. */
  conversationService: ConversationService
  /** Persisted turn whose assistant reply and optional title are generated. */
  conversationTurn: ConversationTurn
  /** Validated controls forwarded to assistant generation. */
  generationOptions: ChatApiRequestBody["generationOptions"]
  /** Model identifier used by both generation tasks. */
  model: string
  /** Reply whose SSE connection receives generation events. */
  reply: ChatRouteReply
  /** Request logger and lifecycle supplied to the chat task. */
  request: ChatRouteRequest
  /** System prompt applied to assistant generation. */
  systemPrompt: string
  /** Inclusive attempt limit applied to title generation. */
  titleGenerationMaxAttempts: number
}

/**
 * Registers the chat completion endpoint on a Fastify application.
 *
 * The registrar mutates `app` by installing the protocol POST/SSE route. Each
 * request sends a conversation-turn start event, then reconciles a stored title
 * for an existing conversation before starting its chat task and, only when
 * the conversation has no stored title, its title task; the handler remains
 * pending until both tasks settle. Chat and generated-title events may then
 * interleave, while client closure aborts the shared upstream work. A missing
 * conversation is translated to HTTP 404; task failures are handled by their
 * task handlers. Any other turn-construction or initial-event failure is
 * rethrown to Fastify, which logs it and responds with HTTP 500 when no event
 * has been sent.
 *
 * @param app - Application instance that receives the chat route.
 * @param options - System prompt and title-generation attempt limit applied to
 * every request.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks The registered handler emits typed SSE start, delta, done, title, or
 * error events. An existing stored title is sent after its turn-start event;
 * failure to send that optional reconciliation is logged and does not prevent
 * chat generation. An `error` event reports only a chat generation failure; a
 * title-generation failure is logged, and a later turn may generate a title if
 * the conversation remains untitled. A generated title is persisted before its
 * event; assistant state is persisted before a supported completion event and
 * is marked interrupted or failed when cancellation/error handling reaches
 * those paths.
 */
export default async function registerChatRoute(
  app: FastifyInstance,
  { lysSystemPrompt, titleGenerationMaxAttempts }: ChatRouteOptions
): Promise<void> {
  /**
   * Handles one validated chat request through turn persistence and generation.
   *
   * @param request - Validated request that owns logging and chat inputs.
   * @param reply - Reply that owns the request's SSE connection.
   * @returns A promise that resolves after both generation tasks settle or the
   * missing-conversation response is sent.
   * @throws Turn construction and initial start-event failures other than a
   * missing conversation; task-specific failures follow their own contracts.
   */
  async function handleChatRequest(
    this: FastifyInstance,
    request: ChatRouteRequest,
    reply: ChatRouteReply
  ) {
    const abortSignal = createAbortSignal(reply)
    const { message, model, conversationId, generationOptions } = request.body

    try {
      const conversationTurn = new ConversationTurn({
        conversationId,
        userMessageContent: message,
        model,
        conversationService: this.conversationService,
        systemPrompt: lysSystemPrompt
      })

      await sendConversationTurnStartEvent(reply, conversationTurn)
      await updateClientConversationTitle(reply, conversationTurn, request.log)
      await startConversationTasks({
        abortSignal,
        chatService: this.chatService,
        conversationService: this.conversationService,
        conversationTurn,
        generationOptions,
        model,
        reply,
        request,
        systemPrompt: lysSystemPrompt,
        titleGenerationMaxAttempts
      })
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return reply.code(404).send({
          message: `Conversation ${conversationId} was not found`
        })
      }

      throw error
    }
  }

  app.route<ChatApiRoute>({
    method: chatApi.method,
    url: chatApi.path,
    sse: "only",
    schema: {
      body: chatApi.body
    },
    handler: handleChatRequest
  })
}

/**
 * Starts the assistant and optional title tasks and owns their settlement.
 *
 * @param options - Persisted turn, generation inputs, services, request
 * lifecycle, and title-attempt limit owned by the route.
 * @returns A promise that resolves after both independently handled tasks
 * settle.
 */
async function startConversationTasks({
  abortSignal,
  chatService,
  conversationService,
  conversationTurn,
  generationOptions,
  model,
  reply,
  request,
  systemPrompt,
  titleGenerationMaxAttempts
}: ConversationTaskStartOptions): Promise<void> {
  const chatTask = createChatTask({
    chatService,
    updateAssistantMessageState: ({ finishReason, status }) => {
      conversationService.updateAssistantMessageState({
        assistantMessageId: conversationTurn.assistantMessage.id,
        status,
        finishReason
      })
    },
    systemPrompt,
    userMessageContent: conversationTurn.userMessage.content,
    model,
    abortSignal,
    request,
    reply,
    generationOptions
  })

  const titleGenerationTask = startUntitledConversationTitleGeneration(
    conversationTurn,
    conversationService,
    {
      chatService,
      model,
      abortSignal,
      reply,
      logger: request.log,
      titleGenerationMaxAttempts
    }
  )

  await Promise.allSettled([chatTask, titleGenerationTask])
}

/**
 * Sends the start event matching whether the turn created its conversation.
 *
 * @param reply - Reply whose SSE connection receives the event.
 * @param conversationTurn - Persisted turn announced to the client.
 * @returns A promise that resolves after Fastify accepts the event write.
 * @throws If the event cannot be written.
 */
async function sendConversationTurnStartEvent(
  reply: ChatRouteReply,
  conversationTurn: ConversationTurn
): Promise<void> {
  const sendEvent = createEventSender(reply)
  const { userMessage, assistantMessage } = conversationTurn

  if (conversationTurn.isNewConversation) {
    await sendEvent({
      type: "start-new-conversation-turn",
      conversation: conversationTurn.conversation,
      userMessage,
      assistantMessage
    })
    return
  }

  await sendEvent({
    type: "start-existing-conversation-turn",
    userMessage,
    assistantMessage
  })
}

/**
 * Updates client title metadata after an existing conversation turn starts.
 *
 * @param reply - Reply whose SSE connection receives the title event.
 * @param conversationTurn - Persisted turn whose existing title may be replayed.
 * @param logger - Request logger that records an optional replay failure.
 * @returns A promise that resolves after the title write or immediately when no
 * stored title is eligible; it does not reject for a title write failure.
 * @remarks New conversations and untitled existing conversations produce no
 * event. A failed write is logged at debug level so optional metadata delivery
 * cannot prevent the already-started conversation from generating its reply.
 */
async function updateClientConversationTitle(
  reply: ChatRouteReply,
  conversationTurn: ConversationTurn,
  logger: FastifyBaseLogger
): Promise<void> {
  const { conversation } = conversationTurn
  if (conversationTurn.isNewConversation || conversation.title === null) {
    return
  }

  try {
    await createEventSender(reply)({
      type: "title",
      title: conversation.title
    })
  } catch (error) {
    logger.debug({ err: error }, "Could not send the stored title event")
  }
}

/**
 * Starts title generation when the turn's conversation has no stored title.
 *
 * @remarks The turn's user message is the title source. A conversation that
 * already has a title keeps it and no title is requested. After an earlier
 * title task fails or is abandoned, the next turn requests a title only if the
 * conversation remains untitled.
 * @param conversationTurn - Persisted turn whose conversation may receive a title.
 * @param conversationService - Store that persists the generated title.
 * @param taskOptions - Service, connection, logger, model, and attempt limit
 * for the title task.
 * @returns A promise that resolves when the title task settles, or at once
 * when the conversation already has a title; it does not reject.
 */
async function startUntitledConversationTitleGeneration(
  conversationTurn: ConversationTurn,
  conversationService: ConversationService,
  taskOptions: UntitledConversationTitleTaskOptions
): Promise<void> {
  const { conversation, userMessage } = conversationTurn
  if (conversation.title !== null) {
    return
  }

  await createTitleGenerationTask({
    ...taskOptions,
    userMessageContent: userMessage.content,
    updateConversationTitle: (title) => {
      return conversationService.updateConversationTitle({
        conversationId: conversation.id,
        conversationTitle: title
      })
    }
  })
}
