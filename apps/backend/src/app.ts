import Fastify from "fastify"
import updateFastifyWithAgentRoutes from "./modules/agent/routes"
import updateFastifyWithConversationRoutes from "./modules/conversation/routes"
import registerHealthRoutes from "./modules/health/routes"
import updateFastifyWithLlmRoutes from "./modules/llm/routes"
import registerChatRoutes from "./modules/chat/routes"
import { backendConfigSchema, type BackendConfig } from "./config"
import singletonServicesPlugin from "./di/fastify"
import { updateFastifyWithHttpTransport } from "./http"

/** Options used to construct the backend Fastify application. */
export type BuildAppOptions = {
  /**
   * Runtime configuration supplied to backend services and plugins.
   *
   * @remarks Must satisfy {@link backendConfigSchema}; the application uses the
   * parsed, frozen snapshot rather than the supplied object.
   */
  config: BackendConfig
}

/**
 * Builds and configures the backend Fastify application.
 *
 * @param options - Runtime dependencies and configuration for the application.
 * @returns A promise that resolves to the Fastify application after SSE support, singleton services, and all backend routes are registered.
 * @throws {z.ZodError} If the configuration does not satisfy
 * {@link backendConfigSchema}; each issue names the failing key, and no
 * application or service has been created.
 * @throws If a plugin or route cannot be registered.
 */
export async function buildApp(options: BuildAppOptions) {
  const config = backendConfigSchema.parse(options.config)
  const app = Fastify({
    logger: true
  })

  await updateFastifyWithHttpTransport(app)
  await app.register(singletonServicesPlugin, {
    config
  })

  // =============== REGISTER THE ROUTES =============== //
  await app.register(registerHealthRoutes)
  await app.register(updateFastifyWithLlmRoutes)
  await app.register(registerChatRoutes, {
    titleGenerationMaxAttempts: config.titleGenerationMaxAttempts
  })
  await app.register(updateFastifyWithConversationRoutes)
  await app.register(updateFastifyWithAgentRoutes)
  // =============== REGISTER THE ROUTES =============== //

  return app
}
