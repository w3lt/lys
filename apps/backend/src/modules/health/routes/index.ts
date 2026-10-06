import { apiHeathCheckRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"

/**
 * Registers the health endpoint on a Fastify application.
 *
 * The registrar mutates `app` by installing the protocol-owned health path;
 * the handler completes with the current static health response.
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
