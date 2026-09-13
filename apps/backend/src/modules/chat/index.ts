import type { FastifyInstance } from "fastify"
import registerChatRoute, { type ChatRouteOptions } from "./chat"

/**
 * Registers all chat routes on a Fastify application.
 *
 * The registrar mutates `app` by installing the chat SSE endpoint and resolves
 * only after its child registrar has completed.
 *
 * @param app - Application instance that receives the chat route group.
 * @param options - Title-generation settings forwarded to the chat route.
 * @returns A promise that resolves after child route registrars complete.
 * @throws If a child route registrar rejects, including for an invalid
 * title-generation attempt limit.
 */
export default async function registerChatRoutes(
  app: FastifyInstance,
  options: ChatRouteOptions
) {
  await registerChatRoute(app, options)
}
