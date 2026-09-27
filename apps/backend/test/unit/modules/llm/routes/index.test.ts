import { describe, expect, it } from "vitest"
import updateFastifyWithLlmRoutes from "../../../../src/modules/llm/routes"
import { createLlmRouteTestApp } from "../../../support/llmRouteTestApp"

describe("updateFastifyWithLlmRoutes", () => {
  it("registers the list, load, unload, and health endpoints", async () => {
    const { app } = createLlmRouteTestApp()

    await updateFastifyWithLlmRoutes(app)
    await app.ready()

    expect(app.hasRoute({ method: "GET", url: "/api/v1/llm/list" })).toBe(true)
    expect(app.hasRoute({ method: "POST", url: "/api/v1/llm/load" })).toBe(true)
    expect(app.hasRoute({ method: "PATCH", url: "/api/v1/llm/unload" })).toBe(
      true
    )
    expect(
      app.hasRoute({ method: "GET", url: "/api/v1/llm/:modelId/health" })
    ).toBe(true)
  })
})
