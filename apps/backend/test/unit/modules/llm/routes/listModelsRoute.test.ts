import {
  createLlmServiceBusyProblem,
  llmInfoSchema,
  llmRuntimeUnavailableProblemSchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import updateFastifyWithLlmListModelsRoute from "../../../../../src/modules/llm/routes/listModelsRoute"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"
import { createLlmRouteTestApp } from "../../../support/llmRouteTestApp"

/** Published path of the inventory route. */
const LIST_MODELS_PATH = "/api/v1/llm/list"

/** Valid inventory snapshot of one loaded model. */
const LOADED_MODEL = llmInfoSchema.parse({
  ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
  loaded: true
})

describe("updateFastifyWithLlmListModelsRoute", () => {
  it("responds with the service inventory", async () => {
    const testApp = createLlmRouteTestApp()
    const listLlmModels = vi
      .spyOn(testApp.service, "listLlmModels")
      .mockResolvedValue(Object.freeze([LOADED_MODEL]))
    await updateFastifyWithLlmListModelsRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: LIST_MODELS_PATH
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ llms: [LOADED_MODEL] })
    expect(listLlmModels).toHaveBeenCalledOnce()
  })

  it("responds with the service-busy problem when admission is refused", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "listLlmModels").mockRejectedValue(
      createLlmServiceBusyError()
    )
    await updateFastifyWithLlmListModelsRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: LIST_MODELS_PATH
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
  })

  it("leaves an inventory failure to the application error boundary", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "listLlmModels").mockRejectedValue(
      new Error("The LLM runtime could not list downloaded models.")
    )
    await updateFastifyWithLlmListModelsRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: LIST_MODELS_PATH
    })

    expect(response.statusCode).toBe(500)
  })

  it("responds with the runtime-unavailable problem when no runtime is connected", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.service, "listLlmModels").mockRejectedValue(
      createLlmRuntimeUnavailableError([])
    )
    await updateFastifyWithLlmListModelsRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: LIST_MODELS_PATH
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
