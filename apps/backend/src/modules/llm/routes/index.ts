import { FastifyInstance } from "fastify"
import { RegisterLlmRoutesOptions } from "./dependencies"
import registerLlmListModelsRoute from "./listModelsRoute"
import registerLlmLoadModelRoute from "./loadModelRoute"

export default async function registerLlmRoutes(
  app: FastifyInstance,
  options: RegisterLlmRoutesOptions
) {
  registerLlmListModelsRoute(app, options)
  registerLlmLoadModelRoute(app, options)
}
