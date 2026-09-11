import { type FastifyInstance } from "fastify"
import updateFastifyWithLlmListModelsRoute from "./listModelsRoute"
import updateFastifyWithLlmModelLoadRoute from "./loadModelRoute"
import updateFastifyWithLlmTestModelRoute from "./testModelRoute"
import updateFastifyWithLlmModelUnloadRoute from "./unloadModelRoute"

/**
 * Adds all LLM lifecycle, inventory, and health routes to a Fastify application.
 *
 * The registrar mutates `app` by installing the list, load, unload, and health
 * endpoints in that order; it does not complete until all child registrations settle.
 *
 * @param app - Application instance that receives the LLM route group.
 * @returns A promise that resolves after child route registrars complete.
 * @throws If a child route registrar rejects.
 */
export default async function updateFastifyWithLlmRoutes(
  app: FastifyInstance
): Promise<void> {
  await updateFastifyWithLlmListModelsRoute(app)
  await updateFastifyWithLlmModelLoadRoute(app)
  await updateFastifyWithLlmModelUnloadRoute(app)
  await updateFastifyWithLlmTestModelRoute(app)
}
