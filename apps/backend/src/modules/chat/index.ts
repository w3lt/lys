import type { FastifyInstance } from "fastify"
import registerChatRoute from "./chat"

/**
 * Registers all chat routes on a Fastify application.
 *
 * The registrar mutates `app` by installing the chat SSE endpoint and resolves
 * only after its child registrar has completed.
 *
 * @param app - Application instance that receives the chat route group.
 * @returns A promise that resolves after child route registrars complete.
 * @throws If a child route registrar rejects.
 */
export default async function registerChatRoutes(app: FastifyInstance) {
  await registerChatRoute(app)
}
