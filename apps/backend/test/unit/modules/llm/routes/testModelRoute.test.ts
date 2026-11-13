import {
  createLlmServiceBusyProblem,
  llmRuntimeUnavailableProblemSchema,
  llmTestModelApi
} from "@lys/protocol"
import { LLM_PROVIDERS } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import type { LlmModelHealthOutcome } from "../../../../../src/modules/llm/getLlmModelHealth"
import { createLlmRuntimeFailureEvidence } from "../../../../../src/modules/llm/llmRuntimeFailureEvidence"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import updateFastifyWithLlmTestModelRoute from "../../../../../src/modules/llm/routes/testModelRoute"
import { createLlmRouteTestApp } from "../../../support/llmRouteTestApp"

/** Canonical model key requested by most cases. */
const MODEL_KEY = "qwen/qwen3-8b"

/**
 * Builds the published health path for one model key of one provider.
 *
 * @param modelKey - Decoded canonical model key.
 * @param provider - Provider the path names, as typed; LM Studio by default.
 * @returns The request path with the key percent-encoded.
 */
function buildHealthPath(
  modelKey: string,
  provider: string = "lmStudio"
): string {
  return llmTestModelApi.path
    .replace(":provider", provider)
    .replace(":modelId", encodeURIComponent(modelKey))
}

describe("updateFastifyWithLlmTestModelRoute", () => {
  it("responds with a fresh ready observation that must not be cached", async () => {
    const testApp = createLlmRouteTestApp()
    const outcome: LlmModelHealthOutcome = {
      health: { modelId: MODEL_KEY, status: "ready", latencyMs: 4 },
      diagnostics: []
    }
    const getLlmModelHealth = vi
      .spyOn(testApp.service, "getLlmModelHealth")
      .mockResolvedValue(outcome)
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: buildHealthPath(MODEL_KEY)
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.json()).toEqual(outcome.health)
    expect(getLlmModelHealth).toHaveBeenCalledExactlyOnceWith(MODEL_KEY)
  })

  it("responds not-ready when the model is not loaded", async () => {
    const testApp = createLlmRouteTestApp()
    const outcome: LlmModelHealthOutcome = {
      health: {
        modelId: MODEL_KEY,
        status: "not-ready",
        reason: "model-not-loaded",
        latencyMs: 4
      },
      diagnostics: []
    }
    vi.spyOn(testApp.service, "getLlmModelHealth").mockResolvedValue(outcome)
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: buildHealthPath(MODEL_KEY)
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.json()).toEqual(outcome.health)
  })

  it("logs the retained runtime failure and keeps it out of the response", async () => {
    const testApp = createLlmRouteTestApp()
    const failure = new Error("connect ECONNREFUSED 127.0.0.1:1234")
    const outcome: LlmModelHealthOutcome = {
      health: {
        modelId: MODEL_KEY,
        status: "not-ready",
        reason: "runtime-unavailable",
        latencyMs: 0
      },
      diagnostics: [createLlmRuntimeFailureEvidence(failure)]
    }
    vi.spyOn(testApp.service, "getLlmModelHealth").mockResolvedValue(outcome)
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: buildHealthPath(MODEL_KEY)
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(outcome.health)
    expect(response.body).not.toContain("ECONNREFUSED")
    expect(
      testApp.log.records.filter(({ level }) => level === "error")
    ).toEqual([
      expect.objectContaining({
        provider: "lmStudio",
        modelKey: MODEL_KEY,
        err: expect.objectContaining({ message: failure.message })
      })
    ])
  })

  it.each(LLM_PROVIDERS)(
    "observes the model on %s, the provider the path names, and asks no other provider",
    async (provider) => {
      const testApp = createLlmRouteTestApp()
      const observations = LLM_PROVIDERS.map((observed) =>
        vi
          .spyOn(
            testApp.llmProviderServices[observed].llmService,
            "getLlmModelHealth"
          )
          .mockResolvedValue({
            health: { modelId: MODEL_KEY, status: "ready", latencyMs: 4 },
            diagnostics: []
          })
      )
      await updateFastifyWithLlmTestModelRoute(testApp.app)

      const response = await testApp.app.inject({
        method: "GET",
        url: buildHealthPath(MODEL_KEY, provider)
      })

      expect(response.statusCode).toBe(200)
      expect(
        observations.map((observation) => observation.mock.calls.length)
      ).toEqual(
        LLM_PROVIDERS.map((observed) => (observed === provider ? 1 : 0))
      )
    }
  )

  it("refuses a path that names no provider Lys can reach before any provider is asked, and keeps it uncached", async () => {
    const testApp = createLlmRouteTestApp()
    const getLlmModelHealth = vi.spyOn(testApp.service, "getLlmModelHealth")
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: buildHealthPath(MODEL_KEY, "ollama-cloud")
    })

    expect(response.statusCode).toBe(400)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(getLlmModelHealth).not.toHaveBeenCalled()
  })

  it("accepts a key of exactly 100 decoded characters", async () => {
    const testApp = createLlmRouteTestApp()
    const modelKey = `€${"k".repeat(99)}`
    const getLlmModelHealth = vi
      .spyOn(testApp.service, "getLlmModelHealth")
      .mockResolvedValue({
        health: {
          modelId: modelKey,
          status: "not-ready",
          reason: "model-not-loaded",
          latencyMs: 0
        },
        diagnostics: []
      })
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: buildHealthPath(modelKey)
    })

    expect(response.statusCode).toBe(200)
    expect(getLlmModelHealth).toHaveBeenCalledExactlyOnceWith(modelKey)
  })

  it("rejects an empty key without querying the service", async () => {
    const testApp = createLlmRouteTestApp()
    const getLlmModelHealth = vi.spyOn(testApp.service, "getLlmModelHealth")
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: buildHealthPath("")
    })

    expect(response.statusCode).toBe(400)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(getLlmModelHealth).not.toHaveBeenCalled()
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "getLlmModelHealth").mockRejectedValue(
      createLlmServiceBusyError()
    )
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: buildHealthPath(MODEL_KEY)
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
  })

  it("responds with the runtime-unavailable problem when no runtime is connected", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "getLlmModelHealth").mockRejectedValue(
      createLlmRuntimeUnavailableError([])
    )
    await updateFastifyWithLlmTestModelRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: buildHealthPath(MODEL_KEY)
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      llmRuntimeUnavailableProblemSchema.safeParse(response.json()).success
    ).toBe(true)
  })
})
