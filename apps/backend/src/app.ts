import Fastify from "fastify"
import { BackendEnv } from "./env"
import registerHealthRoutes from "./modules/health/routes"
import registerLlmRoutes from "./modules/llm/routes"

export type BuildAppOptions = {
  env: BackendEnv
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: true
  })

  // =============== REGISTER THE ROUTES =============== //
  registerHealthRoutes(app)
  registerLlmRoutes(app)
  // =============== REGISTER THE ROUTES =============== //

  return app
}
