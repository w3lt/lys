import { FastifyInstance } from "fastify"
import registerLlmListModelsRoute from "./listModelsRoute"
import registerLlmLoadModelRoute from "./loadModelRoute"

export default async function registerLlmRoutes(app: FastifyInstance) {
  await registerLlmListModelsRoute(app)
  await registerLlmLoadModelRoute(app)
}
