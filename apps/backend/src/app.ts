import Fastify, {
  type FastifyInstance,
  type FastifyLoggerOptions
} from "fastify"
import updateFastifyWithAgentRoutes from "./modules/agent/routes"
import updateFastifyWithConversationRoutes from "./modules/conversation/routes"
import registerHealthRoutes from "./modules/health/routes"
import updateFastifyWithLlmRoutes from "./modules/llm/routes"
import registerChatRoutes from "./modules/chat/routes"
import registerToolRoutes from "./modules/tool/routes"
import { backendConfigSchema, type BackendConfig } from "./config"
import singletonServicesPlugin from "./di/fastify"
import { updateFastifyWithHttpTransport } from "./http"
import { buildBackendLoggerOptions } from "./log"

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
   * Destination of the application's log: one JSON object per line, with the
   * level name in `level`, such as `"info"`, and the UTC ISO-8601 time in
   * `time`.
   *
   * A request's lines carry its full URL, query string included.
   *
   * @remarks Owned by the caller, which decides where the lines go; the
   * application writes to it but never ends or closes it. Its `write` must not
   * throw. A stream destination reports a failed write through its `error`
   * event, which its owner handles, such as the backend entry point through
   * `registerOutputFailureListeners`; the application keeps serving either
   * way.
   */
  logDestination: NonNullable<FastifyLoggerOptions["stream"]>
}

/**
 * Builds and configures the backend Fastify application.
 *
 * The application logs at level `info` to {@link BuildAppOptions.logDestination}.
 *
 * @param options - Runtime dependencies and configuration for the application.
 * @returns A promise that resolves to the Fastify application after SSE support, singleton services, and all backend routes are registered.
 * @throws {z.ZodError} If the configuration does not satisfy
 * {@link backendConfigSchema}; each issue names the failing key, and no
 * application or service has been created.
 * @throws If a plugin or route cannot be registered.
 */
export async function buildApp(
  options: BuildAppOptions
): Promise<FastifyInstance> {
  const config = backendConfigSchema.parse(options.config)
  const loggerOptions = buildBackendLoggerOptions(
    "info",
    options.logDestination
  )
  const app = Fastify({ logger: loggerOptions })

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
  // =============== REGISTER THE ROUTES =============== //

  return app
}
