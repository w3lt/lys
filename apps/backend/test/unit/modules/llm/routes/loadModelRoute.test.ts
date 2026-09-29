import {
  createLlmServiceBusyProblem,
  llmLoadModelApiResponseBodySchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
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
    expect(loadLlmModel).toHaveBeenCalledExactlyOnceWith("qwen3")
  })

  it.each([
    ["a missing model identifier", {}],
    ["an empty model identifier", { modelId: "" }],
    ["a numeric model identifier", { modelId: 42 }],
    ["an additional property", { modelId: "qwen", extra: true }]
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
})
