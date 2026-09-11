import { chatApi, type ChatApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import { createAbortSignal, createEventSender } from "./share"
import ConversationTurn from "./conversationTurn"
import createChatTask from "./chatTask"
import createTitleGenerationTask from "./titleGenerationTask"
import { ConversationNotFoundError } from "../../../utils/errors"

/**
 * Registers the chat completion endpoint on a Fastify application.
 *
 * The registrar mutates `app` by installing the protocol POST/SSE route. Each
 * request sends a conversation-turn start event before starting chat and title
 * tasks concurrently; the handler remains pending until both tasks settle.
 * Chat and title events may then interleave, while client closure aborts the
 * shared upstream work. A missing conversation is translated to HTTP 404;
 * task failures are translated by their task handlers where possible, while
 * turn-construction or initial-event failures are caught without an extra
 * route-level response.
 *
 * @param app - Application instance that receives the chat route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks The registered handler emits typed SSE start, delta, done, title, or
 * error events. The title is persisted before its event; assistant state is
 * persisted before a supported completion event and is marked interrupted or
 * failed when cancellation/error handling reaches those paths.
 */
export default async function registerChatRoute(app: FastifyInstance) {
  app.route<ChatApiRoute>({
    method: chatApi.method,
    url: chatApi.path,
    sse: "only",
    schema: {
      body: chatApi.body
    },
    handler: async function (this, request, reply) {
      const abortSignal = createAbortSignal(reply)
      const sendEvent = createEventSender(reply)

      const { message, model, conversationId, generationOptions } = request.body
      try {
        const conversationTurn = new ConversationTurn({
          model,
          conversationService: this.conversationService,
          conversationId,
          userMessageContent: message
        })

        const userMessage = conversationTurn.userMessage
        const assistantMessage = conversationTurn.assistantMessage

        const isNewConversation = conversationTurn.isNewConversation
        if (isNewConversation) {
          await sendEvent({
            type: "start-new-conversation-turn",
            conversation: conversationTurn.conversation,
            userMessage,
            assistantMessage
          })
        } else {
          await sendEvent({
            type: "start-existing-conversation-turn",
            userMessage,
            assistantMessage
          })
        }

        const chatTask = createChatTask({
          abortSignal,
          chatService: this.chatService,
          model,
          reply,
          request,
          userMessageContent: userMessage.content,
          generationOptions,
          updateAssistantMessageState: ({ finishReason, status }) => {
            this.conversationService.updateAssistantMessageState({
              assistantMessageId: assistantMessage.id,
              finishReason,
              status
            })
          }
        })

        const titleGenerationTask = createTitleGenerationTask({
          abortSignal,
          chatService: this.chatService,
          model,
          reply,
          userMessageContent: userMessage.content,
          updateConversationTitle: (title) => {
            this.conversationService.updateConversationTitle({
              conversationId: conversationTurn.conversation.id,
              conversationTitle: title
            })
          }
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
