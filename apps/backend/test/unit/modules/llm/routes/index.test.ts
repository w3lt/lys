import { describe, expect, it } from "vitest"
import updateFastifyWithLlmRoutes from "../../../../../src/modules/llm/routes"
import { createLlmRouteTestApp } from "../../../support/llmRouteTestApp"

describe("updateFastifyWithLlmRoutes", () => {
  it("registers the list, load, unload, health, runtime-status, and runtime-connect endpoints, each for the provider its path names", async () => {
    const { app } = createLlmRouteTestApp()

    await updateFastifyWithLlmRoutes(app)
    await app.ready()

    expect(
      app.hasRoute({ method: "GET", url: "/api/v1/llm/:provider/list" })
    ).toBe(true)
    expect(
      app.hasRoute({ method: "POST", url: "/api/v1/llm/:provider/load" })
    ).toBe(true)
    expect(
      app.hasRoute({ method: "PATCH", url: "/api/v1/llm/:provider/unload" })
    ).toBe(true)
    expect(
      app.hasRoute({
        method: "GET",
        url: "/api/v1/llm/:provider/:modelId/health"
      })
    ).toBe(true)
    expect(
      app.hasRoute({ method: "GET", url: "/api/v1/llm/:provider/runtime" })
    ).toBe(true)
    expect(
      app.hasRoute({
        method: "POST",
        url: "/api/v1/llm/:provider/runtime/connect"
      })
    ).toBe(true)
  })
})
