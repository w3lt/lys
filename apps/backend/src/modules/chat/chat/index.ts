import { chatApi, type ChatApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import {
  createAbortSignal,
  createEventSender,
  type ChatRouteReply
} from "./share"
import ConversationTurn from "./conversationTurn"
import createChatTask from "./chatTask"
import createTitleGenerationTask, {
  type CreateTitleGenerationTaskOptions
} from "./titleGenerationTask"
import { ConversationNotFoundError } from "../../../utils/errors"
import type ConversationService from "../../../di/services/conversationService"
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

/**
 * Registers the chat completion endpoint on a Fastify application.
 *
 * The registrar mutates `app` by installing the protocol POST/SSE route. Each
 * request sends a conversation-turn start event before starting its chat task
 * and, only when the conversation has no stored title, its title task; the
 * handler remains pending until both settle. Chat and title events may then
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
 * error events. An `error` event reports only a chat generation failure; a
 * title-generation failure is logged and the conversation stays untitled until
 * a later turn generates its title. The title is persisted before its event;
 * assistant state is persisted before a supported completion event and is
 * marked interrupted or failed when cancellation/error handling reaches those
 * paths.
 */
export default async function registerChatRoute(
  app: FastifyInstance,
  { lysSystemPrompt, titleGenerationMaxAttempts }: ChatRouteOptions
) {
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
          systemPrompt: lysSystemPrompt,
          userMessageContent: message
        })

        await sendConversationTurnStartEvent(reply, conversationTurn)

        const chatTask = createChatTask({
          abortSignal,
          chatService: this.chatService,
          model,
          reply,
          request,
          systemPrompt: lysSystemPrompt,
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

        const titleGenerationTask = startUntitledConversationTitleGeneration(
          conversationTurn,
          this.conversationService,
          {
            abortSignal,
            chatService: this.chatService,
            logger: request.log,
            model,
            reply,
            titleGenerationMaxAttempts
          }
        )

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

        throw error
      }
    }
  })
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
 * Starts title generation when the turn's conversation has no stored title.
 *
 * @remarks The turn's user message is the title source. A conversation that
 * already has a title keeps it and no title is requested. A conversation whose
 * earlier title generation failed or was abandoned is still untitled, so its
 * next turn requests a title again.
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
      conversationService.updateConversationTitle({
        conversationId: conversation.id,
        conversationTitle: title
      })
    }
  })
}
