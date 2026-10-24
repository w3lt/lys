import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify"
import updateFastifyWithAgentRoutes from "./modules/agent/routes"
import updateFastifyWithConversationRoutes from "./modules/conversation/routes"
import registerHealthRoutes from "./modules/health/routes"
import updateFastifyWithLlmRoutes from "./modules/llm/routes"
import registerMcpRoutes from "./modules/mcp/routes"
import registerChatRoutes from "./modules/chat/routes"
import registerToolRoutes from "./modules/tool/routes"
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
  /**
   * The backend's logger, which the application, its requests, and its
   * services log to.
   *
   * @remarks Borrowed: the application logs through a child of it and never
   * changes or closes it. Its level decides which lines are written; the
   * backend's logger, from `createBackendLogger`, writes `info` and above,
   * with request lines that carry the full URL, query string included.
   */
  logger: FastifyBaseLogger
}

/**
 * Builds and configures the backend Fastify application.
 *
 * The application logs to {@link BuildAppOptions.logger}.
 *
 * @param options - Runtime dependencies and configuration for the application.
 * @returns A promise that resolves to the Fastify application after SSE support, singleton services, and all backend routes are registered.
 * @throws {z.ZodError} If the configuration does not satisfy
 * {@link backendConfigSchema}; each issue names the failing key, and no
 * application or service has been created, so nothing is logged.
 * @throws If a plugin or route cannot be registered, such as when the
 * database cannot be opened.
 */
export async function buildApp(
  options: BuildAppOptions
): Promise<FastifyInstance> {
  const config = backendConfigSchema.parse(options.config)
  const app = Fastify({ loggerInstance: options.logger })

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
  await app.register(registerToolRoutes)
  await app.register(registerMcpRoutes)
  // =============== REGISTER THE ROUTES =============== //

  return app
}
