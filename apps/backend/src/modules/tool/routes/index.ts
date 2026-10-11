import {
  listBackendToolsApi,
  type ListBackendToolsApiResponse,
  type ListBackendToolsApiRoute
} from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"

/**
 * Registers the endpoint that lists the tools the backend runs.
 *
 * @param app - Application whose singleton services hold the built-in tools.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route. The failure rejects the
 * promise, so `app.register` reports it rather than an uncaught exception.
 * @remarks The list is fixed for the backend's lifetime: every built-in
 * tool's definition, in the order Settings lists them.
 */
export default function registerToolRoutes(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerListBackendToolsRoute(app)
    resolve()
  })
}

/**
 * Registers the endpoint that lists the built-in tools.
 *
 * @param app - Application whose singleton services hold the built-in tools.
 * @throws If Fastify cannot register the route.
 */
function registerListBackendToolsRoute(app: FastifyInstance): void {
  const tools = Object.freeze(app.builtInTools.map((entry) => entry.definition))
  const response: ListBackendToolsApiResponse = Object.freeze({ tools })
  app.route<ListBackendToolsApiRoute>({
    method: listBackendToolsApi.method,
    url: listBackendToolsApi.path,
    schema: {
      response: {
        200: z.toJSONSchema(listBackendToolsApi.responses[200], {
          target: "draft-7"
        })
      }
    },
    handler: () => response
  })
}
