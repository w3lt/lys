import type { FastifyInstance } from "fastify"
import { serializerCompiler } from "fastify-type-provider-zod"
import registerChatContextRoute from "./chatContextRoute"
import registerChatRoute from "./chatRoute"
import { createLlmModelCapabilitiesLookup } from "./modelCapabilities"
import updateFastifyWithChatReplyRoutes from "./replyRoutes"
import updateFastifyWithVoiceRoutes from "../../voice/routes"

/**
 * Registers all chat routes.
 *
 * @param app - Application instance that receives the chat route group, with
 * the singleton services installed.
 * @returns A promise that resolves after child route registrars complete.
 * @throws If a child route registrar fails. The failure rejects the promise,
 * so `app.register` reports it rather than an uncaught exception.
 * @remarks The routes start turns through the application's turn start and
 * find running generations in its reply generation registry, which the
 * application disposes when it closes; nothing is disposed here.
 */
export default function registerChatRoutes(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerChatRouteGroup(app)
    resolve()
  })
}

/**
 * Registers the chat, chat-context, reply, and speech endpoints with the
 * response serializer and the model capability lookup they share.
 *
 * @param app - Application with SSE, validation, and the singleton services
 * installed.
 * @throws If a child route registrar fails.
 * @remarks The group's JSON responses are serialized with their Zod schemas.
 * The chat and chat-context routes share one model capability lookup, so a
 * model's capabilities are listed from its connected provider once for both,
 * and listed again after that provider connects at another address or with
 * another key. Each provider's models are listed and remembered apart.
 */
function registerChatRouteGroup(app: FastifyInstance): void {
  app.setSerializerCompiler(serializerCompiler)
  const findModelCapabilities = createLlmModelCapabilitiesLookup(
    app.llmProviderServices
  )
  registerChatRoute(app, findModelCapabilities)
  registerChatContextRoute(app, findModelCapabilities)
  updateFastifyWithChatReplyRoutes(app)
  updateFastifyWithVoiceRoutes(app)
}
