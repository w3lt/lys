import { createLlmServiceBusyProblem } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import updateFastifyWithLlmTestModelRoute from "../../../../src/modules/llm/routes/testModelRoute"
import { findLogRecords } from "../../../support/fastifyTestApp"
import {
  createLlmRouteTestApp,
  occupyLlmServiceCapacity
} from "../../../support/llmRouteTestApp"

/** Log message written for a retained inventory failure. */
const HEALTH_FAILURE_LOG =
  "LLM runtime state could not be established during model health query"

/**
 * Builds the published health path for one model key.
 *
 * @param modelKey - Decoded canonical model key.
 * @returns The request path with the key percent-encoded.
 */
function healthPath(modelKey: string): string {
  return `/api/v1/llm/${encodeURIComponent(modelKey)}/health`
}

describe("updateFastifyWithLlmTestModelRoute", () => {
  it("responds with a fresh ready observation that must not be cached", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances.mockResolvedValue([
      { modelKey: "qwen/qwen3-8b", modelIdentifier: "qwen/qwen3-8b" }
    ])
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: healthPath("qwen/qwen3-8b")
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.json()).toEqual({
      modelId: "qwen/qwen3-8b",
      status: "ready",
      latencyMs: 0
    })
  })

  it("responds not-ready when the model is not loaded", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances.mockResolvedValue([])
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: healthPath("qwen/qwen3-8b")
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      modelId: "qwen/qwen3-8b",
      status: "not-ready",
      reason: "model-not-loaded",
      latencyMs: 0
    })
  })

  it("logs the retained runtime failure and keeps it out of the response", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:1234")
    )
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: healthPath("qwen/qwen3-8b")
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      modelId: "qwen/qwen3-8b",
      status: "not-ready",
      reason: "runtime-unavailable",
      latencyMs: 0
    })
    expect(response.body).not.toContain("ECONNREFUSED")
    expect(findLogRecords(testApp.logs, HEALTH_FAILURE_LOG)).toEqual([
      expect.objectContaining({
        level: "error",
        modelKey: "qwen/qwen3-8b",
        err: expect.objectContaining({
          message: "connect ECONNREFUSED 127.0.0.1:1234"
        })
      })
    ])
  })

  it("accepts a key of exactly 100 decoded characters", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listLoadedLlmModelInstances.mockResolvedValue([])
    await updateFastifyWithLlmTestModelRoute(testApp.app)
    const modelKey = `€${"k".repeat(99)}`

    const response = await testApp.app.inject({
      method: "GET",
      url: healthPath(modelKey)
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ modelId: modelKey })
  })

  it("rejects an empty key without querying the runtime", async () => {
    const testApp = createLlmRouteTestApp()
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: healthPath("")
    })

    expect(response.statusCode).toBe(400)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(testApp.runtime.listLoadedLlmModelInstances).not.toHaveBeenCalled()
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    await updateFastifyWithLlmTestModelRoute(testApp.app)
    const releaseCapacity = occupyLlmServiceCapacity(testApp)

    const response = await testApp.app.inject({
      method: "GET",
      url: healthPath("qwen/qwen3-8b")
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
    await releaseCapacity()
  })
})
