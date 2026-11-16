import type { FastifyInstance } from "fastify"
import fastifySse from "@fastify/sse"
import fastifyWebsocket from "@fastify/websocket"
import cors from "@fastify/cors"
import { validatorCompiler } from "fastify-type-provider-zod"
import { DESKTOP_ORIGINS } from "./httpOrigins"

/**
 * Configures validation, SSE, WebSocket, and browser access for the loopback HTTP boundary.
 * @param app - Application whose transport plugins and compiler are installed.
 * @returns Settlement after the transport is ready for route registration.
 * @throws If a transport plugin cannot be registered.
 * @remarks CORS admits the development and Tauri desktop origins, including DELETE
 * preflights. It does not authenticate non-browser callers; the host binds loopback.
 */
export async function updateFastifyWithHttpTransport(
  app: FastifyInstance
): Promise<void> {
  app.setValidatorCompiler(validatorCompiler)
  await app.register(cors, {
    origin: [...DESKTOP_ORIGINS],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
  })
  await app.register(fastifySse)
  await app.register(fastifyWebsocket)
}
