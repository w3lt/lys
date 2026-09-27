import { createLlmServiceBusyProblem } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import updateFastifyWithLlmModelLoadRoute from "../../../../src/modules/llm/routes/loadModelRoute"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"
import {
  createLlmRouteTestApp,
  occupyLlmServiceCapacity
} from "../../../support/llmRouteTestApp"

/** Published path of the load route. */
const LOAD_MODEL_PATH = "/api/v1/llm/load"

describe("updateFastifyWithLlmModelLoadRoute", () => {
  it("loads the requested key or alias and responds with the canonical model", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.loadLlmModel.mockResolvedValue(
      Object.freeze({
        modelKey: "qwen/qwen3-8b",
        modelIdentifier: "qwen/qwen3-8b"
      })
    )
    testApp.runtime.listDownloadedLlmModels.mockResolvedValue([
      createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" })
    ])
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload: { modelId: "qwen3" }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
      loaded: true
    })
    expect(testApp.runtime.loadLlmModel).toHaveBeenCalledWith("qwen3")
  })

  it.each([
    ["a missing model identifier", {}],
    ["an empty model identifier", { modelId: "" }],
    ["a numeric model identifier", { modelId: 42 }],
    ["an additional property", { modelId: "qwen", extra: true }]
  ])("rejects %s before loading", async (_label, payload) => {
    const testApp = createLlmRouteTestApp()
    await updateFastifyWithLlmModelLoadRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "POST",
      url: LOAD_MODEL_PATH,
      payload
    })

    expect(response.statusCode).toBe(400)
    expect(testApp.runtime.loadLlmModel).not.toHaveBeenCalled()
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    await updateFastifyWithLlmModelLoadRoute(testApp.app)
    const releaseCapacity = occupyLlmServiceCapacity(testApp)

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
    await releaseCapacity()
    expect(testApp.runtime.loadLlmModel).not.toHaveBeenCalled()
  })

  it("leaves a load failure to the application error boundary", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.loadLlmModel.mockRejectedValue(
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
