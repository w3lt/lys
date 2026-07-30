import { apiHeathCheckRoute } from "@lys/protocol"
import { FastifyInstance } from "fastify"

export default async function registerHealthRoutes(app: FastifyInstance) {
  app.get(apiHeathCheckRoute, async () => ({
    ok: true
  }))
}
