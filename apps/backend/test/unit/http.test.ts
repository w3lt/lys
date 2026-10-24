import { requestSourceRefusedProblemSchema } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import { connect } from "node:net"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import {
  updateFastifyWithHttpTransport,
  type BackendListenAddress
} from "../../src/http"
import { parseSseEvents } from "./support/chatSseRoute"
import { createTestFastify } from "./support/fastifyTestApp"

/** Address the backend listens on in these cases, as in production. */
const BACKEND_ADDRESS: BackendListenAddress = Object.freeze({
  backendHost: "127.0.0.1",
  backendPort: 12_345
})

/** `Host` the desktop sends with every request to the backend. */
const DESKTOP_HOST = "127.0.0.1:12345"

/** Origins of the desktop renderer: Vite in development, and the installed app. */
const DESKTOP_ORIGINS = [
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost"
] as const

/** Body that refuses a request whose `Host` does not name the backend. */
const HOST_REFUSAL = Object.freeze({
  type: "urn:lys:problem:http:request-source-refused",
  title: "Request source refused",
  status: 403,
  detail:
    "The backend answers only requests addressed to 127.0.0.1:12345 or localhost:12345."
})

/** Body that refuses a request from a page that is not the desktop's. */
const ORIGIN_REFUSAL = Object.freeze({
  type: "urn:lys:problem:http:request-source-refused",
  title: "Request source refused",
  status: 403,
  detail: "The backend answers only pages of the Lys desktop app."
})

/**
 * Creates an application owned by the current test with the transport installed.
 *
 * @returns The application after the transport is ready for route registration.
 */
async function createTransportApp(): Promise<FastifyInstance> {
  const { app } = createTestFastify()
  await updateFastifyWithHttpTransport(app, BACKEND_ADDRESS)
  return app
}

/**
 * Sends one HTTP/1.0 request without a `Host` header over a real socket,
 * which `inject` cannot do because it always adds one.
 *
 * @param port - Loopback port the application listens on.
 * @param path - Path of the route to request.
 * @returns The status code of the answer.
 */
async function sendRequestWithoutHost(
  port: number,
  path: string
): Promise<number> {
  const socket = connect({ host: "127.0.0.1", port })
  socket.setEncoding("utf8")
  socket.end(`GET ${path} HTTP/1.0\r\n\r\n`)
  let response = ""
  for await (const chunk of socket) response += String(chunk)
  return Number(response.split(" ")[1])
}

describe("updateFastifyWithHttpTransport", () => {
  it("validates route input against its zod schema", async () => {
    const app = await createTransportApp()
    app.post("/echo", {
      schema: { body: z.strictObject({ name: z.string().min(1) }) },
      handler: async (request) => request.body
    })

    const accepted = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { host: DESKTOP_HOST },
      payload: { name: "Lys" }
    })
    const rejected = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { host: DESKTOP_HOST },
      payload: { name: "" }
    })

    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toEqual({ name: "Lys" })
    expect(rejected.statusCode).toBe(400)
  })

  // Host names are case-insensitive, so a capitalized name is the same name.
  it.each(["127.0.0.1:12345", "localhost:12345", "LOCALHOST:12345"])(
    "serves a request addressed to %s",
    async (host) => {
      const app = await createTransportApp()
      const handler = vi.fn(async () => ({ ok: true }))
      app.get("/resource", handler)

      const response = await app.inject({
        method: "GET",
        url: "/resource",
        headers: { host }
      })

      expect(response.statusCode).toBe(200)
      expect(handler).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ["a name rebound to loopback", "rebound.attacker.example:12345"],
    ["another port", "127.0.0.1:1420"],
    ["no port", "127.0.0.1"],
    ["the IPv6 loopback address", "[::1]:12345"],
    ["another loopback address", "127.0.0.2:12345"]
  ])(
    "refuses a request whose Host is %s before the route runs",
    async (_case, host) => {
      const app = await createTransportApp()
      const handler = vi.fn(async () => ({ ok: true }))
      app.post("/resource", handler)

      const response = await app.inject({
        method: "POST",
        url: "/resource",
        headers: { host }
      })

      expect(response.statusCode).toBe(403)
      expect(response.headers["content-type"]).toBe(
        "application/problem+json; charset=utf-8"
      )
      expect(response.json()).toEqual(HOST_REFUSAL)
      expect(
        requestSourceRefusedProblemSchema.safeParse(response.json()).success
      ).toBe(true)
      expect(handler).not.toHaveBeenCalled()
    }
  )

  it("refuses a request that names no Host before the route runs", async () => {
    const app = await createTransportApp()
    const handler = vi.fn(async () => ({ ok: true }))
    app.get("/resource", handler)
    const address = await app.listen({ host: "127.0.0.1", port: 0 })

    const statusCode = await sendRequestWithoutHost(
      Number(new URL(address).port),
      "/resource"
    )

    expect(statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it.each(DESKTOP_ORIGINS)(
    "serves a request from the desktop origin %s and grants it CORS access",
    async (origin) => {
      const app = await createTransportApp()
      const handler = vi.fn(async () => ({ ok: true }))
      app.get("/resource", handler)

      const response = await app.inject({
        method: "GET",
        url: "/resource",
        headers: { host: DESKTOP_HOST, origin }
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers["access-control-allow-origin"]).toBe(origin)
      expect(handler).toHaveBeenCalledOnce()
    }
  )

  it("serves a request without an Origin, such as one from a local script", async () => {
    const app = await createTransportApp()
    const handler = vi.fn(async () => ({ ok: true }))
    app.get("/resource", handler)

    const response = await app.inject({
      method: "GET",
      url: "/resource",
      headers: { host: DESKTOP_HOST }
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers["access-control-allow-origin"]).toBeUndefined()
    expect(handler).toHaveBeenCalledOnce()
  })

  // The last two differ from a desktop origin by one component only. A POST
  // without a body needs no preflight, so only this check stops it.
  it.each([
    "https://attacker.example",
    "null",
    "http://localhost:5173",
    "https://localhost:1420"
  ])(
    "refuses a request from the origin %s before the route runs",
    async (origin) => {
      const app = await createTransportApp()
      const handler = vi.fn(async () => ({ ok: true }))
      app.post("/resource", handler)

      const response = await app.inject({
        method: "POST",
        url: "/resource",
        headers: { host: DESKTOP_HOST, origin }
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual(ORIGIN_REFUSAL)
      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
      expect(handler).not.toHaveBeenCalled()
    }
  )

  it.each(DESKTOP_ORIGINS)(
    "admits a DELETE preflight from %s",
    async (origin) => {
      const app = await createTransportApp()
      app.delete("/resource", async () => ({ deleted: true }))

      const response = await app.inject({
        method: "OPTIONS",
        url: "/resource",
        headers: {
          host: DESKTOP_HOST,
          origin,
          "access-control-request-method": "DELETE"
        }
      })

      expect(response.statusCode).toBe(204)
      expect(response.headers["access-control-allow-origin"]).toBe(origin)
      expect(
        String(response.headers["access-control-allow-methods"])
          .split(",")
          .map((method) => method.trim())
      ).toContain("DELETE")
    }
  )

  it("refuses a preflight from another site", async () => {
    const app = await createTransportApp()
    app.delete("/resource", async () => ({ deleted: true }))

    const response = await app.inject({
      method: "OPTIONS",
      url: "/resource",
      headers: {
        host: DESKTOP_HOST,
        origin: "https://attacker.example",
        "access-control-request-method": "DELETE"
      }
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual(ORIGIN_REFUSAL)
    expect(response.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("lets routes send server-sent events to the desktop", async () => {
    const app = await createTransportApp()
    app.get("/events", { sse: "only" }, async (_request, reply) => {
      await reply.sse.send({ event: "ping", data: { sequence: 1 } })
    })

    const response = await app.inject({
      method: "GET",
      url: "/events",
      headers: {
        host: DESKTOP_HOST,
        origin: "tauri://localhost",
        accept: "text/event-stream"
      }
    })

    expect(response.headers["content-type"]).toBe("text/event-stream")
    expect(parseSseEvents(response.body)).toEqual([
      { event: "ping", data: { sequence: 1 } }
    ])
  })
})
