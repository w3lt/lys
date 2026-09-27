import { describe, expect, it } from "vitest"
import registerHealthRoutes from "../../../../src/modules/health/routes"
import { createTestFastify } from "../../support/fastifyTestApp"

describe("registerHealthRoutes", () => {
  it("answers the published health path with an ok status", async () => {
    const { app } = createTestFastify()
    await registerHealthRoutes(app)

    const response = await app.inject({ method: "GET", url: "/api/v1/heath" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it("registers the health path for GET only", async () => {
    const { app } = createTestFastify()
    await registerHealthRoutes(app)

    const response = await app.inject({ method: "POST", url: "/api/v1/heath" })

    expect(response.statusCode).toBe(404)
  })
})
