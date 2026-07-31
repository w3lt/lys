import { FastifyInstance } from "fastify"
import registerChatRoute from "./chat"

export default async function registerChatRoutes(app: FastifyInstance) {
  await registerChatRoute(app)
}
