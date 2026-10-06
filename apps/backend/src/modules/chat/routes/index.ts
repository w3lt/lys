import type { FastifyInstance } from "fastify"
import registerChatRoute, { type ChatRouteOptions } from "./chatRoute"
import ReplyGenerationRegistry from "../replyGenerationRegistry"
import updateFastifyWithChatReplyRoutes from "./replyRoutes"

/**
 * Registers all chat routes and the registry that owns their generations.
 *
 * @param app - Application instance that receives the chat route group.
 * @param options - System prompt and title-generation attempt limit forwarded
 * to the chat route.
 * @returns A promise that resolves after child route registrars complete.
 * @throws If a child route registrar fails.
 * @remarks The registry is disposed in `preClose`, while SSE streams are
 * still open: every generation stores its final state and its followers end
 * before the server waits for requests and before services close SQLite.
 */
export default async function registerChatRoutes(
  app: FastifyInstance,
  options: ChatRouteOptions
) {
  const generations = new ReplyGenerationRegistry()
  app.addHook("preClose", async () => {
    await generations[Symbol.asyncDispose]()
  })
  registerChatRoute(app, { ...options, generations })
  await updateFastifyWithChatReplyRoutes(app, generations)
}
