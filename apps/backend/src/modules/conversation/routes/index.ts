import { type FastifyInstance } from "fastify"
import registerListConversationsRoute from "./listConversationsRoute"

export default async function registerConversationRoutes(app: FastifyInstance) {
  registerListConversationsRoute(app)
}
