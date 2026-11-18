import { SPEECH_CLOSE_SHUTDOWN } from "@lys/protocol"
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
 * When the application closes, every open WebSocket, which is always a speech
 * socket, is closed with the shutdown code before requests are drained.
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
  await app.register(fastifyWebsocket, { preClose: closeSocketsForShutdown })
}

/**
 * Closes every open WebSocket for the application's shutdown.
 *
 * @param this - Application whose WebSocket server is closing.
 * @returns Settlement once the WebSocket server stopped; it never rejects.
 * @remarks Replaces the plugin's own `preClose`, which closes sockets
 * without a code, so the desktop reads the shutdown from `1001`.
 */
async function closeSocketsForShutdown(this: FastifyInstance): Promise<void> {
  for (const client of this.websocketServer.clients)
    client.close(SPEECH_CLOSE_SHUTDOWN)
  await new Promise<void>((resolve) => {
    this.websocketServer.close(() => resolve())
  })
}
