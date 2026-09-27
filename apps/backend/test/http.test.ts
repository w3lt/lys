import { describe, expect, it } from "vitest"
import * as z from "zod"
import { updateFastifyWithHttpTransport } from "../src/http"
import { parseSseEvents } from "./support/chatSseRoute"
import { createTestFastify } from "./support/fastifyTestApp"

/**
 * Creates an application with the HTTP transport installed.
 *
 * @returns The application after the transport is ready for routes.
 */
async function createTransportApp() {
  const testFastify = createTestFastify()
  await updateFastifyWithHttpTransport(testFastify.app)
  return testFastify.app
}

describe("updateFastifyWithHttpTransport", () => {
  it("validates route input with zod schemas", async () => {
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
  ])("allows a DELETE preflight from %s", async (origin) => {
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
      String(response.headers["access-control-allow-methods"])
        .split(",")
        .map((method) => method.trim())
    ).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"])
  })

  it("does not grant another origin access", async () => {
    const app = await createTransportApp()
    app.get("/resource", async () => ({ ok: true }))

    const response = await app.inject({
      method: "GET",
      url: "/resource",
      headers: { origin: "http://example.com" }
    })

    expect(response.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("provides server-sent events to routes", async () => {
    const app = await createTransportApp()
    app.get("/events", { sse: "only" }, async (_request, reply) => {
      await reply.sse.send({ event: "ping", data: { n: 1 } })
    })

    const response = await app.inject({
      method: "GET",
      url: "/events",
      headers: { accept: "text/event-stream" }
    })

    expect(response.headers["content-type"]).toBe("text/event-stream")
    expect(parseSseEvents(response.body)).toEqual([
      { event: "ping", data: { n: 1 } }
    ])
  })
})
