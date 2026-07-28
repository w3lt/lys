import { FastifyInstance } from "fastify"
import registerLlmListModelsRoute from "./listModelsRoute"

export default async function registerLlmRoutes(app: FastifyInstance) {
  registerLlmListModelsRoute(app)
}

