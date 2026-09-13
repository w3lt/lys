import Fastify from "fastify"
import updateFastifyWithConversationRoutes from "./modules/conversation"
import registerHealthRoutes from "./modules/health/routes"
import updateFastifyWithLlmRoutes from "./modules/llm/routes"
import registerChatRoutes from "./modules/chat"
import { type BackendConfig } from "./config"
import singletonServicesPlugin from "./di/fastify"
import { updateFastifyWithHttpTransport } from "./http"

/** Options used to construct the backend Fastify application. */
export type BuildAppOptions = {
  /** Runtime configuration supplied to backend services and plugins. */
  config: BackendConfig
}

/**
 * Builds and configures the backend Fastify application.
 *
 * @param options - Runtime dependencies and configuration for the application.
 * @returns A promise that resolves to the Fastify application after SSE support, singleton services, and all backend routes are registered.
 * @throws If a plugin or route cannot be registered.
 */
export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: true
  })

  await updateFastifyWithHttpTransport(app)
  await app.register(singletonServicesPlugin, {
    config: options.config
  })

  // =============== REGISTER THE ROUTES =============== //
  await app.register(registerHealthRoutes)
  await app.register(updateFastifyWithLlmRoutes)
  await app.register(registerChatRoutes)
  await app.register(updateFastifyWithConversationRoutes)
  // =============== REGISTER THE ROUTES =============== //

  return app
}
