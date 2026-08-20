import { conversationGetApi, type ConversationGetApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"

export default function registerGetConversationRoute(app: FastifyInstance) {
  app.route<ConversationGetApiRoute>({
    method: conversationGetApi.method,
    url: conversationGetApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(conversationGetApi.response, {
          target: "draft-07"
        })
      }
    },
    handler: async function (this, request, reply) {
      const { conversationId } = request.params
      const conversation = this.conversationService.getConversationMetadata({
        id: conversationId
      })

      if (!conversation) {
        reply.code(404)
        return
      }

      return {
        ...conversation,
        messages: []
      }
    }
  })
}
