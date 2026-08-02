import type { ChatApiRoute, ChatApiStreamEvent } from "@lys/protocol"
import { chatApi } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import { v7 as uuidv7 } from "uuid"

/**
 * Registers the chat completion endpoint on a Fastify application.
 *
 * @param app - Application instance that receives the chat route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 * @remarks The registered handler emits typed SSE start, delta, done, or error
 * events, and aborts the upstream completion when the client disconnects.
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
      const abortController = new AbortController()
      reply.sse.onClose(() => {
        abortController.abort()
      })

      /**
       * Sends one typed chat event through the active SSE connection.
       *
       * @param event - Protocol event whose type also becomes the SSE event name.
       * @returns A promise that resolves after Fastify writes the event.
       */
      const sendEvent = async (event: ChatApiStreamEvent) => {
        await reply.sse.send({
          event: event.type,
          data: event
        })
      }

      const {
        conversationId: conversationIdParams,
        message,
        model
      } = request.body
      const isNewConversation = !conversationIdParams

      const conversation = isNewConversation
        ? this.conversationService.createConversation()
        : this.conversationService.getConversationMetadata({
            id: conversationIdParams
          })

      if (!conversation) {
        return reply.code(404).send({
          message: `Conversation ${conversationIdParams} was not found`
        })
      }

      const assistantMessageId = uuidv7()

      await sendEvent({
        type: "start",
        conversation,
        assistantMessageId
      })

      const chatTask = this.chatService
        .completeChatStream({
          messages: [
            {
              role: "user",
              content: message
            }
          ],
          model,
          stream: true,
          signal: abortController.signal
        })
        .then(async (stream) => {
          for await (const chunk of stream) {
            // We request only one completion, whose index is 0.
            // Some chunks may have an empty choices array.
            const choice = chunk.choices.find(({ index }) => index === 0)

            if (!choice) continue

            const content = choice.delta.content
            if (content) {
              sendEvent({
                type: "delta",
                content
              })
            }

            switch (choice.finish_reason) {
              case null:
                continue

              case "stop":
              case "length":
                await sendEvent({
                  type: "done",
                  finishReason: choice.finish_reason
                })
                return

              default:
                throw new Error(
                  `Unsupported finish reason: ${choice.finish_reason}`
                )
            }
          }

          throw new Error("Model stream ended without a finish reason")
        })
        .catch(async (error) => {
          request.log.error({ err: error }, "Chat completion stream failed")

          // The client is gone, so there is nowhere to send an error event.
          if (abortController.signal.aborted || !reply.sse.isConnected) {
            return
          }

          await sendEvent({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unknown chat completion error"
          })
        })

      const titleGenerationTask = isNewConversation
        ? this.chatService
            .generateTitle({
              message,
              model,
              signal: abortController.signal
            })
            .then(async (title) => {
              await sendEvent({
                type: "title",
                title
              })
            })
            .catch(async (error) => {
              await sendEvent({
                type: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Unknown title generation error"
              })
            })
        : Promise.resolve()

      /*
       * Both tasks were already started and are running concurrently.
       * This only prevents the handler—and therefore the SSE connection—from
       * ending until both have settled.
       */
      await Promise.allSettled([chatTask, titleGenerationTask])
    }
  })
}
