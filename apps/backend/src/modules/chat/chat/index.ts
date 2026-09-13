import { chatApi, type ChatApiRoute } from "@lys/protocol"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import {
  createAbortSignal,
  createEventSender,
  type ChatRouteReply
} from "./share"
import ConversationTurn from "./conversationTurn"
import createChatTask from "./chatTask"
import createTitleGenerationTask from "./titleGenerationTask"
import { ConversationNotFoundError } from "../../../utils/errors"
import type ChatService from "../../../di/services/chatService"
import type ConversationService from "../../../di/services/conversationService"

/** Settings applied by the chat route to every request. */
export type ChatRouteOptions = {
  /**
   * Inclusive maximum number of title-generation requests for one new
   * conversation.
   *
   * @remarks Must be a positive safe integer; registration rejects any other
   * value. Only a reply unusable as a title consumes another request.
   */
  titleGenerationMaxAttempts: number
}

/** Route-owned services and turn values used to title a new conversation. */
type StartNewConversationTitleGenerationOptions = {
  /** Signal aborted when the SSE client disconnects. */
  readonly abortSignal: AbortSignal
  /** Application-scoped service that generates the title. */
  readonly chatService: ChatService
  /** Application-scoped store that persists the generated title. */
  readonly conversationService: ConversationService
  /** Persisted turn whose conversation may receive a title. */
  readonly conversationTurn: ConversationTurn
  /** Request-scoped logger for title-generation outcomes. */
  readonly logger: FastifyBaseLogger
  /** Model identifier used for title generation. */
  readonly model: string
  /** Reply whose SSE connection receives the title event. */
  readonly reply: ChatRouteReply
  /** Validated inclusive maximum number of title requests. */
  readonly titleGenerationMaxAttempts: number
}

/**
 * Registers the chat completion endpoint on a Fastify application.
 *
 * The registrar validates the title-generation attempt limit and then mutates
 * `app` by installing the protocol POST/SSE route. Each request sends a
 * conversation-turn start event before starting its chat task and, only when
 * the turn created the conversation, its title task; the handler remains
 * pending until both settle. Chat and title events may then interleave, while
 * client closure aborts the shared upstream work. A missing conversation is
 * translated to HTTP 404; task failures are handled by their task handlers,
 * while turn-construction or initial-event failures are caught without an
 * extra route-level response.
 *
 * @param app - Application instance that receives the chat route.
 * @param options - Title-generation settings applied to every request.
 * @returns A promise that resolves after route registration completes.
 * @throws {RangeError} If the title-generation attempt limit is not a positive
 * safe integer.
 * @throws If Fastify cannot register the route.
 * @remarks The registered handler emits typed SSE start, delta, done, title, or
 * error events. An `error` event reports only a chat generation failure; a
 * title-generation failure is logged and the conversation keeps its default
 * title. The title is persisted before its event; assistant state is persisted
 * before a supported completion event and is marked interrupted or failed when
 * cancellation/error handling reaches those paths.
 */
export default async function registerChatRoute(
  app: FastifyInstance,
  options: ChatRouteOptions
) {
  const titleGenerationMaxAttempts = parseTitleGenerationMaxAttempts(
    options.titleGenerationMaxAttempts
  )

  app.route<ChatApiRoute>({
    method: chatApi.method,
    url: chatApi.path,
    sse: "only",
    schema: {
      body: chatApi.body
    },
    handler: async function (this, request, reply) {
      const abortSignal = createAbortSignal(reply)

      const { message, model, conversationId, generationOptions } = request.body
      try {
        const conversationTurn = new ConversationTurn({
          model,
          conversationService: this.conversationService,
          conversationId,
          userMessageContent: message
        })

        await sendConversationTurnStartEvent(reply, conversationTurn)

        const chatTask = createChatTask({
          abortSignal,
          chatService: this.chatService,
          model,
          reply,
          request,
          userMessageContent: conversationTurn.userMessage.content,
          generationOptions,
          updateAssistantMessageState: ({ finishReason, status }) => {
            this.conversationService.updateAssistantMessageState({
              assistantMessageId: conversationTurn.assistantMessage.id,
              finishReason,
              status
            })
          }
        })

        const titleGenerationTask = startNewConversationTitleGeneration({
          abortSignal,
          chatService: this.chatService,
          conversationService: this.conversationService,
          conversationTurn,
          logger: request.log,
          model,
          reply,
          titleGenerationMaxAttempts
        })

        /*
         * Both tasks were already started and are running concurrently.
         * This only prevents the handler—and therefore the SSE connection—from
         * ending until both have settled.
         */
        await Promise.allSettled([chatTask, titleGenerationTask])
      } catch (error) {
        if (error instanceof ConversationNotFoundError) {
          return reply.code(404).send({
            message: `Conversation ${conversationId} was not found`
          })
        }
      }
    }
  })
}

/**
 * Validates the configured title-generation attempt limit.
 *
 * @param titleGenerationMaxAttempts - Configured inclusive attempt limit.
 * @returns The same limit once it is known to be a positive safe integer.
 * @throws {RangeError} If the limit is not a positive safe integer.
 */
function parseTitleGenerationMaxAttempts(
  titleGenerationMaxAttempts: number
): number {
  if (
    !Number.isSafeInteger(titleGenerationMaxAttempts) ||
    titleGenerationMaxAttempts < 1
  ) {
    throw new RangeError(
      `The title-generation attempt limit must be a positive safe integer, received ${titleGenerationMaxAttempts}`
    )
  }

  return titleGenerationMaxAttempts
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
 * Starts title generation when the turn created its conversation.
 *
 * @remarks A continued conversation keeps its stored title, so no title is
 * requested for it.
 * @param options - Services, turn, connection, and attempt limit for the task.
 * @returns A promise that resolves when the title task settles, or at once for
 * a continued conversation; it does not reject.
 */
async function startNewConversationTitleGeneration({
  abortSignal,
  chatService,
  conversationService,
  conversationTurn,
  logger,
  model,
  reply,
  titleGenerationMaxAttempts
}: StartNewConversationTitleGenerationOptions): Promise<void> {
  if (!conversationTurn.isNewConversation) {
    return
  }

  const conversationId = conversationTurn.conversation.id
  await createTitleGenerationTask({
    abortSignal,
    chatService,
    logger,
    model,
    reply,
    titleGenerationMaxAttempts,
    userMessageContent: conversationTurn.userMessage.content,
    updateConversationTitle: (title) => {
      conversationService.updateConversationTitle({
        conversationId,
        conversationTitle: title
      })
    }
  })
}
