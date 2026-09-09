import { type FastifyInstance } from "fastify"
import registerLlmListModelsRoute from "./listModelsRoute"
import registerLlmLoadModelRoute from "./loadModelRoute"
import registerLlmUnloadModelRoute from "./unloadModelRoute"

/**
 * Registers all LLM lifecycle and inventory routes on a Fastify application.
 *
 * The registrar mutates `app` by installing the list, load, and unload
 * endpoints in that order; it does not complete until all child registrations
 * settle.
 *
 * @param app - Application instance that receives the LLM route group.
 * @returns A promise that resolves after child route registrars complete.
 * @throws If a child route registrar rejects.
 */
export default async function registerLlmRoutes(
  app: FastifyInstance
): Promise<void> {
  await registerLlmListModelsRoute(app)
  await registerLlmLoadModelRoute(app)
  await registerLlmUnloadModelRoute(app)
}
