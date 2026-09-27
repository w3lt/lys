import { createLlmServiceBusyProblem } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import updateFastifyWithLlmListModelsRoute from "../../../../../src/modules/llm/routes/listModelsRoute"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"
import {
  createLlmRouteTestApp,
  occupyLlmServiceCapacity
} from "../../../support/llmRouteTestApp"

/** Published path of the inventory route. */
const LIST_MODELS_PATH = "/api/v1/llm/list"

describe("updateFastifyWithLlmListModelsRoute", () => {
  it("responds with the service inventory", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listDownloadedLlmModels.mockResolvedValue([
      createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" })
    ])
    testApp.runtime.listLoadedLlmModelInstances.mockResolvedValue([
      { modelKey: "qwen/qwen3-8b", modelIdentifier: "qwen/qwen3-8b" }
    ])
    await updateFastifyWithLlmListModelsRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: LIST_MODELS_PATH
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      llms: [
        {
          ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
          loaded: true
        }
      ]
    })
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    await updateFastifyWithLlmListModelsRoute(testApp.app)
    const releaseCapacity = occupyLlmServiceCapacity(testApp)

    const response = await testApp.app.inject({
      method: "GET",
      url: LIST_MODELS_PATH
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
    await releaseCapacity()
    expect(testApp.runtime.listDownloadedLlmModels).not.toHaveBeenCalled()
  })

  it("leaves an inventory failure to the application error boundary", async () => {
    const testApp = createLlmRouteTestApp()
    testApp.runtime.listDownloadedLlmModels.mockRejectedValue(
      new Error("The LLM runtime could not list downloaded models.")
    )
    await updateFastifyWithLlmListModelsRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: LIST_MODELS_PATH
    })

    expect(response.statusCode).toBe(500)
  })
})
