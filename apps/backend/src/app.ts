import Fastify from "fastify"
import registerHealthRoutes from "./modules/health/routes"
import registerLlmRoutes from "./modules/llm/routes"

export type BackendConfig = {
  backendHost: string
  backendPort: number
  lmstudioHost: string
  lmstudioPort: number
}

export type BuildAppOptions = {
  config: BackendConfig
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: true
  })

  void options

  // =============== REGISTER THE ROUTES =============== //
  registerHealthRoutes(app)
  registerLlmRoutes(app)
  // =============== REGISTER THE ROUTES =============== //

  return app
}
