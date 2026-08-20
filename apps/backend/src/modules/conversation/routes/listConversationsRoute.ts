import type { FastifyInstance } from "fastify"
import {
  conversationListApi,
  type ConversationListApiRoute
} from "@lys/protocol"
import * as z from "zod"

export default async function registerListConversationsRoute(
  app: FastifyInstance
) {
  app.route<ConversationListApiRoute>({
    method: conversationListApi.method,
    url: conversationListApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(conversationListApi.response, {
          target: "draft-07"
        })
      }
    },
    handler: async function (this, request) {
      const { cursor, limit, query } = request.query
      const results = this.conversationService.listConversationMetadata({
        cursor,
        limit,
        query
      })

      return {
        conversations: results.conversations.map((c) => ({
          ...c,
          excerpt: null // Null for now. TODO: need to support the excerpt
        })),
        matchCount: results.conversations.length,
        nextCursor: results.nextCursor,
        total: results.total
      }
    }
  })
}
