import type { FastifyInstance } from "fastify"
import { serializerCompiler } from "fastify-type-provider-zod"
import registerChatContextRoute from "./chatContextRoute"
import registerChatRoute, { type ChatRouteOptions } from "./chatRoute"
import { createModelCapabilitiesLookup } from "./modelCapabilities"
import ReplyGenerationRegistry from "../replyGenerationRegistry"
import updateFastifyWithChatReplyRoutes from "./replyRoutes"

/**
 * Registers all chat routes and the registry that owns their generations.
 *
 * @param app - Application instance that receives the chat route group.
 * @param options - Title-generation attempt limit forwarded to the chat route.
 * @returns A promise that resolves after child route registrars complete.
 * @throws If a child route registrar fails. The failure rejects the promise,
 * so `app.register` reports it rather than an uncaught exception.
 * @remarks The group's JSON responses are serialized with their Zod schemas.
 * The chat and chat-context routes share one model capability lookup, so a
 * model's capabilities are listed from LM Studio once for both.
 * The registry is disposed in `preClose`, while SSE streams are still open:
 * every generation stores its final state and its followers end before the
 * server waits for requests and before services close SQLite.
 */
export default function registerChatRoutes(
  app: FastifyInstance,
  options: ChatRouteOptions
): Promise<void> {
  return new Promise((resolve) => {
    const generations = new ReplyGenerationRegistry()
    app.addHook("preClose", async () => {
      await generations[Symbol.asyncDispose]()
    })
    app.setSerializerCompiler(serializerCompiler)
    const findModelCapabilities = createModelCapabilitiesLookup(() =>
      app.llmService.listDownloadedLlmModels()
    )
    registerChatRoute(app, { ...options, generations, findModelCapabilities })
    registerChatContextRoute(app, findModelCapabilities)
    updateFastifyWithChatReplyRoutes(app, generations)
    resolve()
  })
}
