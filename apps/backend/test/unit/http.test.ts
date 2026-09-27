import type { FastifyInstance } from "fastify"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { updateFastifyWithHttpTransport } from "../../src/http"
import { parseSseEvents } from "./support/chatSseRoute"
import { createTestFastify } from "./support/fastifyTestApp"

/**
 * Creates an application owned by the current test with the transport installed.
 *
 * @returns The application after the transport is ready for route registration.
 */
async function createTransportApp(): Promise<FastifyInstance> {
  const { app } = createTestFastify()
  await updateFastifyWithHttpTransport(app)
  return app
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
      payload: { name: "Lys" }
    })
    const rejected = await app.inject({
      method: "POST",
      url: "/echo",
      payload: { name: "" }
    })

    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toEqual({ name: "Lys" })
    expect(rejected.statusCode).toBe(400)
  })

  it.each([
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost"
  ])("admits a DELETE preflight from %s", async (origin) => {
    const app = await createTransportApp()
    app.delete("/resource", async () => ({ deleted: true }))

    const response = await app.inject({
      method: "OPTIONS",
      url: "/resource",
      headers: { origin, "access-control-request-method": "DELETE" }
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers["access-control-allow-origin"]).toBe(origin)
    expect(
      new Set(
        String(response.headers["access-control-allow-methods"])
          .split(",")
          .map((method) => method.trim())
      )
    ).toEqual(new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]))
  })

  // Each origin differs from an admitted one by one component only.
  it.each(["http://localhost:5173", "https://localhost:1420"])(
    "grants no cross-origin access to %s",
    async (origin) => {
      const app = await createTransportApp()
      app.get("/resource", async () => ({ ok: true }))

      const response = await app.inject({
        method: "GET",
        url: "/resource",
        headers: { origin }
      })

      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
    }
  )

  it("lets routes send server-sent events", async () => {
    const app = await createTransportApp()
    app.get("/events", { sse: "only" }, async (_request, reply) => {
      await reply.sse.send({ event: "ping", data: { sequence: 1 } })
    })

    const response = await app.inject({
      method: "GET",
      url: "/events",
      headers: { accept: "text/event-stream" }
    })

    expect(response.headers["content-type"]).toBe("text/event-stream")
    expect(parseSseEvents(response.body)).toEqual([
      { event: "ping", data: { sequence: 1 } }
    ])
  })
})
