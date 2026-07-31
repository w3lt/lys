import { chatApi, ChatApiRoute, ChatApiStreamEvent } from "@lys/protocol"
import { FastifyInstance } from "fastify"
import { v7 as uuidv7 } from "uuid"

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
      const conversationId = conversationIdParams ?? uuidv7()
      const assistantMessageId = uuidv7()

      await sendEvent({
        type: "start",
        conversationId,
        assistantMessageId
      })

      try {
        const stream = await this.chatService.completeChatStream({
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
      } catch (error) {
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
      }
    }
  })
}
