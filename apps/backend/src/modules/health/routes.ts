import { apiHeathCheckRoute } from "@lys/protocol"
import { FastifyInstance } from "fastify"

/**
 * Registers the health endpoint on a Fastify application.
 *
 * @param app - Application instance that receives the health route.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route.
 */
export default async function registerHealthRoutes(app: FastifyInstance) {
  app.get(apiHeathCheckRoute, async () => ({
    ok: true
  }))
}
