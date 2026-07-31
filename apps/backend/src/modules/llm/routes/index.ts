import { FastifyInstance } from "fastify"
import registerLlmListModelsRoute from "./listModelsRoute"
import registerLlmLoadModelRoute from "./loadModelRoute"

/**
 * Registers all LLM lifecycle and inventory routes on a Fastify application.
 *
 * @param app - Application instance that receives the LLM route group.
 * @returns A promise that resolves after child route registrars complete.
 * @throws If a child route registrar rejects.
 */
export default async function registerLlmRoutes(app: FastifyInstance) {
  await registerLlmListModelsRoute(app)
  await registerLlmLoadModelRoute(app)
}
