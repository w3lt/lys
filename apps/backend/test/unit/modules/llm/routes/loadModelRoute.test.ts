import {
  createLlmServiceBusyProblem,
  llmLoadModelApiResponseBodySchema,
  llmRuntimeUnavailableProblemSchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import updateFastifyWithLlmModelLoadRoute from "../../../../../src/modules/llm/routes/loadModelRoute"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"
import { createLlmRouteTestApp } from "../../../support/llmRouteTestApp"

/** Published path of the load route. */
const LOAD_MODEL_PATH = "/api/v1/llm/load"

/** Valid canonical metadata of the model the service reports as loaded. */
const LOADED_MODEL = llmLoadModelApiResponseBodySchema.parse({
  ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
  loaded: true
})

describe("updateFastifyWithLlmModelLoadRoute", () => {
  it("loads the requested key or alias and responds with the canonical model", async () => {
    const testApp = createLlmRouteTestApp()
    const loadLlmModel = vi
      .spyOn(testApp.service, "loadLlmModel")
      .mockResolvedValue(LOADED_MODEL)
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload: { modelId: "qwen3" }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(LOADED_MODEL)
    expect(loadLlmModel).toHaveBeenCalledExactlyOnceWith("qwen3", {})
  })

  it("passes the request's load settings to the loader", async () => {
    const testApp = createLlmRouteTestApp()
    const loadLlmModel = vi
      .spyOn(testApp.service, "loadLlmModel")
      .mockResolvedValue(LOADED_MODEL)
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload: {
        modelId: "qwen3",
        configuration: {
          contextLength: 16_384,
          evalBatchSize: 1024,
          flashAttention: false,
          offloadKVCacheToGpu: true,
          numExperts: 4
        }
      }
    })

    expect(response.statusCode).toBe(200)
    expect(loadLlmModel).toHaveBeenCalledExactlyOnceWith("qwen3", {
      contextLength: 16_384,
      evalBatchSize: 1024,
      flashAttention: false,
      offloadKVCacheToGpu: true,
      numExperts: 4
    })
  })

  it.each([
    ["the smallest whole-number setting", { contextLength: 1 }],
    ["the largest whole-number setting", { contextLength: 4_294_967_295 }],
    ["an empty configuration", {}]
  ])("accepts %s", async (_label, configuration) => {
    const testApp = createLlmRouteTestApp()
    const loadLlmModel = vi
      .spyOn(testApp.service, "loadLlmModel")
      .mockResolvedValue(LOADED_MODEL)
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload: { modelId: "qwen3", configuration }
    })

    expect(response.statusCode).toBe(200)
    expect(loadLlmModel).toHaveBeenCalledExactlyOnceWith("qwen3", configuration)
  })

  it.each([
    ["a missing model identifier", {}],
    ["an empty model identifier", { modelId: "" }],
    ["a numeric model identifier", { modelId: 42 }],
    ["an additional property", { modelId: "qwen", extra: true }],
    ["a null configuration", { modelId: "qwen", configuration: null }],
    ["a text configuration", { modelId: "qwen", configuration: "fast" }],
    [
      "an unknown load setting",
      { modelId: "qwen", configuration: { seed: 1 } }
    ],
    [
      "a zero context length",
      { modelId: "qwen", configuration: { contextLength: 0 } }
    ],
    [
      "a negative context length",
      { modelId: "qwen", configuration: { contextLength: -1 } }
    ],
    [
      "a fractional context length",
      { modelId: "qwen", configuration: { contextLength: 1.5 } }
    ],
    [
      "a text context length",
      { modelId: "qwen", configuration: { contextLength: "8192" } }
    ],
    [
      "a context length above the largest whole-number setting",
      { modelId: "qwen", configuration: { contextLength: 4_294_967_296 } }
    ],
    [
      "a zero eval batch size",
      { modelId: "qwen", configuration: { evalBatchSize: 0 } }
    ],
    [
      "a zero expert count",
      { modelId: "qwen", configuration: { numExperts: 0 } }
    ],
    [
      "a text flash attention setting",
      { modelId: "qwen", configuration: { flashAttention: "on" } }
    ],
    [
      "a null KV cache setting",
      { modelId: "qwen", configuration: { offloadKVCacheToGpu: null } }
    ]
  ])("rejects %s before loading", async (_label, payload) => {
    const testApp = createLlmRouteTestApp()
    const loadLlmModel = vi.spyOn(testApp.service, "loadLlmModel")
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload
    })

    expect(response.statusCode).toBe(400)
    expect(loadLlmModel).not.toHaveBeenCalled()
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "loadLlmModel").mockRejectedValue(
      createLlmServiceBusyError()
    )
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload: { modelId: "qwen3" }
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
  })

  it("leaves a load failure to the application error boundary", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "loadLlmModel").mockRejectedValue(
      new Error("The LLM runtime could not load the model.")
    )
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload: { modelId: "qwen3" }
    })

    expect(response.statusCode).toBe(500)
  })

  it("responds with the runtime-unavailable problem when no runtime is connected", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "loadLlmModel").mockRejectedValue(
      createLlmRuntimeUnavailableError([])
    )
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload: { modelId: "qwen3" }
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      llmRuntimeUnavailableProblemSchema.safeParse(response.json()).success
    ).toBe(true)
  })
})
