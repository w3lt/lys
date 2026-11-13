import {
  buildLlmProviderApiPath,
  createLlmServiceBusyProblem,
  llmInfoSchema,
  llmListModelsApi,
  llmRuntimeUnavailableProblemSchema
} from "@lys/protocol"
import { LLM_PROVIDERS } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import updateFastifyWithLlmListModelsRoute from "../../../../../src/modules/llm/routes/listModelsRoute"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"
import { createLlmRouteTestApp } from "../../../support/llmRouteTestApp"

/** Published path of LM Studio's inventory route. */
const LIST_MODELS_PATH = buildLlmProviderApiPath(
  llmListModelsApi.path,
  "lmStudio"
)

/** Valid inventory snapshot of one loaded model with its context length. */
const LOADED_MODEL = llmInfoSchema.parse({
  ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
  loaded: true,
  loadedContextLength: 8192
})

describe("updateFastifyWithLlmListModelsRoute", () => {
  it.each(["lys", "provider"] as const)(
    "responds with the service inventory, each loaded model's context length, and who loads the models (%s)",
    async (modelLoading) => {
      const testApp = createLlmRouteTestApp()
      const listLlmModels = vi
        .spyOn(testApp.service, "listLlmModels")
        .mockResolvedValue(
          Object.freeze({ llms: Object.freeze([LOADED_MODEL]), modelLoading })
        )
      await updateFastifyWithLlmListModelsRoute(testApp.app)

      const response = await testApp.app.inject({
        method: "GET",
        url: LIST_MODELS_PATH
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ llms: [LOADED_MODEL], modelLoading })
      expect(listLlmModels).toHaveBeenCalledOnce()
    }
  )

  it.each(LLM_PROVIDERS)(
    "lists the models of %s, the provider the path names, and asks no other provider",
    async (provider) => {
      const testApp = createLlmRouteTestApp()
      const listings = LLM_PROVIDERS.map((listed) =>
        vi
          .spyOn(
            testApp.llmProviderServices[listed].llmService,
            "listLlmModels"
          )
          .mockResolvedValue(
            Object.freeze({ llms: Object.freeze([]), modelLoading: "lys" })
          )
      )
      await updateFastifyWithLlmListModelsRoute(testApp.app)

      const response = await testApp.app.inject({
        method: "GET",
        url: buildLlmProviderApiPath(llmListModelsApi.path, provider)
      })

      expect(response.statusCode).toBe(200)
      expect(listings.map((listing) => listing.mock.calls.length)).toEqual(
        LLM_PROVIDERS.map((listed) => (listed === provider ? 1 : 0))
      )
    }
  )

  it("refuses a path that names no provider Lys can reach before any provider is asked", async () => {
    const testApp = createLlmRouteTestApp()
    const listLlmModels = vi.spyOn(testApp.service, "listLlmModels")
    await updateFastifyWithLlmListModelsRoute(testApp.app)

    const response = await testApp.app.inject({
      method: "GET",
      url: llmListModelsApi.path.replace(":provider", "lmstudio")
    })

    expect(response.statusCode).toBe(400)
    expect(listLlmModels).not.toHaveBeenCalled()
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
