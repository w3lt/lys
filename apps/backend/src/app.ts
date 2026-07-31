import Fastify from "fastify"
import registerHealthRoutes from "./modules/health/routes"
import registerLlmRoutes from "./modules/llm/routes"
import registerChatRoutes from "./modules/chat"
import fastifySse from "@fastify/sse"
import { BackendConfig } from "./config"
import singletonServicesPlugin from "./di/fastify"

export type BuildAppOptions = {
  config: BackendConfig
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: true
  })

  await app.register(fastifySse)
  await app.register(singletonServicesPlugin, {
    config: options.config
  })

  // =============== REGISTER THE ROUTES =============== //
  await app.register(registerHealthRoutes)
  await app.register(registerLlmRoutes)
  await app.register(registerChatRoutes)
  // =============== REGISTER THE ROUTES =============== //

  return app
}
