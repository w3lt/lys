import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import fastifySse from "@fastify/sse"
import cors from "@fastify/cors"
import {
  requestSourceRefusedProblemSchema,
  type RequestSourceRefusedProblem
} from "@lys/protocol"
import { validatorCompiler } from "fastify-type-provider-zod"
import type { BackendConfig } from "./config"

/**
 * Origins of the desktop renderer: the Vite development server, under both
 * loopback names, and the installed Tauri app.
 *
 * @remarks CORS grants these origins access, and the transport refuses a
 * request that carries any other `Origin` before routing.
 */
const DESKTOP_ORIGINS: readonly string[] = Object.freeze([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost"
])

/** Caller-safe detail of a refused `Origin`. */
const ORIGIN_REFUSAL_DETAIL =
  "The backend answers only pages of the Lys desktop app."

/**
 * Address the backend listens on, from its configuration.
 *
 * @remarks The transport serves a request only when its `Host` header names
 * this address, or `localhost`, with this port.
 */
export type BackendListenAddress = Pick<
  BackendConfig,
  "backendHost" | "backendPort"
>

/**
 * Configures validation, the request source check, browser access, and SSE
 * for the loopback HTTP boundary.
 * @param app - Application whose transport plugins and compiler are installed.
 * @param address - Address the backend listens on, which a request's `Host`
 * must name.
 * @returns Settlement after the transport is ready for route registration.
 * @throws If a transport plugin cannot be registered.
 * @remarks The source check runs first for every request, before CORS, body
 * parsing, and every route, the 404 handler included. It refuses with the 403
 * request-source problem a `Host` other than `<backendHost>:<backendPort>`
 * or `localhost:<backendPort>`, such as the name a page that uses DNS
 * rebinding sends, and an `Origin` other than a desktop origin. A request
 * without `Origin` is served, so the check stops web pages but not other
 * local processes. CORS admits the desktop origins, including DELETE
 * preflights.
 */
export async function updateFastifyWithHttpTransport(
  app: FastifyInstance,
  address: BackendListenAddress
): Promise<void> {
  app.setValidatorCompiler(validatorCompiler)
  const backendHosts = Object.freeze([
    `${address.backendHost}:${address.backendPort}`,
    `localhost:${address.backendPort}`
  ])
  app.addHook("onRequest", async (request, reply) =>
    handleIncomingRequest(request, reply, backendHosts)
  )
  await app.register(cors, {
    origin: [...DESKTOP_ORIGINS],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
  })
  await app.register(fastifySse)
}

/**
 * Refuses an incoming request from a source the backend does not serve,
 * before anything else handles it.
 * @param request - Request whose headers are checked; its body is not read.
 * @param reply - Response owner, used only to send a refusal.
 * @param backendHosts - Lowercased `Host` values that name the backend.
 * @returns The sent reply when the request is refused, which ends it;
 * `undefined` when the request may go on.
 */
function handleIncomingRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  backendHosts: readonly string[]
): FastifyReply | undefined {
  const detail = findRequestSourceRefusalDetail(request, backendHosts)
  if (detail === undefined) return undefined
  return reply
    .code(403)
    .type("application/problem+json")
    .send(createRequestSourceRefusedProblem(detail))
}

/**
 * Finds why a request's `Host` or `Origin` shows a source the backend does
 * not serve.
 * @param request - Request whose headers are read.
 * @param backendHosts - Lowercased `Host` values that name the backend.
 * @returns Caller-safe text naming the refused header, checked `Host` first;
 * `undefined` when the `Host` names the backend and the request carries no
 * `Origin` or a desktop one.
 * @remarks A missing `Host` is refused. Host names compare without case;
 * origins compare exactly, as CORS compares them.
 */
function findRequestSourceRefusalDetail(
  request: FastifyRequest,
  backendHosts: readonly string[]
): string | undefined {
  const host = request.headers.host?.toLowerCase()
  if (host === undefined || !backendHosts.includes(host)) {
    return `The backend answers only requests addressed to ${backendHosts.join(" or ")}.`
  }
  const origin = request.headers.origin
  if (origin !== undefined && !DESKTOP_ORIGINS.includes(origin)) {
    return ORIGIN_REFUSAL_DETAIL
  }
  return undefined
}

/**
 * Creates the caller-safe response for a request from a source the backend
 * does not serve.
 * @param detail - Text naming the refused header.
 * @returns The strict problem body sent with HTTP 403.
 */
function createRequestSourceRefusedProblem(
  detail: string
): RequestSourceRefusedProblem {
  const { shape } = requestSourceRefusedProblemSchema.unwrap()
  return Object.freeze({
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail
  })
}
