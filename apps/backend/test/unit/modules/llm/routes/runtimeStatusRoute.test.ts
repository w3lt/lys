import {
  buildLlmProviderApiPath,
  llmRuntimeConnectionApiResponseSchema,
  llmRuntimeStatusApi,
  type LlmRuntimeConnectionStatus
} from "@lys/protocol"
import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import updateFastifyWithLlmRuntimeStatusRoute from "../../../../../src/modules/llm/routes/runtimeStatusRoute"
import { createLlmRouteTestApp } from "../../../support/llmRouteTestApp"

/** Status each provider's runtime reports in the independence case. */
const PROVIDER_STATUSES = Object.freeze({
  lmStudio: "connected",
  ollama: "off",
  ollamaCloud: "unreachable",
  groq: "connecting"
} satisfies Readonly<Record<LlmProvider, LlmRuntimeConnectionStatus>>)

describe("updateFastifyWithLlmRuntimeStatusRoute", () => {
  it.each([
    "connecting",
    "connected",
    "unreachable",
    "off"
  ] as const satisfies readonly LlmRuntimeConnectionStatus[])(
    "responds with the %s status without contacting the runtime or entering the queue",
    async (status) => {
      const testApp = createLlmRouteTestApp()
      const readStatus = vi
        .spyOn(testApp.runtimeService, "llmRuntimeConnectionStatus", "get")
        .mockReturnValue(status)
      const connectLlmRuntime = vi.spyOn(
        testApp.runtimeService,
        "connectLlmRuntime"
      )
      const handleLlmEngineOperationRequest = vi.spyOn(
        testApp.runtimeService,
        "handleLlmEngineOperationRequest"
      )
      await updateFastifyWithLlmRuntimeStatusRoute(testApp.app)

      const response = await testApp.app.inject({
        method: llmRuntimeStatusApi.method,
        url: buildLlmProviderApiPath(llmRuntimeStatusApi.path, "lmStudio")
      })

      expect(response.statusCode).toBe(200)
      expect(
        llmRuntimeConnectionApiResponseSchema.parse(response.json())
      ).toEqual({ status })
      expect(readStatus).toHaveBeenCalled()
      expect(connectLlmRuntime).not.toHaveBeenCalled()
      expect(handleLlmEngineOperationRequest).not.toHaveBeenCalled()
    }
  )

  it("responds with the status of the provider the path names, whatever the others' are", async () => {
    const testApp = createLlmRouteTestApp()
    for (const provider of LLM_PROVIDERS) {
      vi.spyOn(
        testApp.llmProviderServices[provider].llmRuntimeService,
        "llmRuntimeConnectionStatus",
        "get"
      ).mockReturnValue(PROVIDER_STATUSES[provider])
    }
    await updateFastifyWithLlmRuntimeStatusRoute(testApp.app)

    const statuses = await Promise.all(
      LLM_PROVIDERS.map(async (provider) => {
        const response = await testApp.app.inject({
          method: llmRuntimeStatusApi.method,
          url: buildLlmProviderApiPath(llmRuntimeStatusApi.path, provider)
        })
        return llmRuntimeConnectionApiResponseSchema.parse(response.json())
          .status
      })
    )

    expect(statuses).toEqual(
      LLM_PROVIDERS.map((provider) => PROVIDER_STATUSES[provider])
    )
  })

  it("refuses a path that names no provider Lys can reach", async () => {
    const testApp = createLlmRouteTestApp()
    await updateFastifyWithLlmRuntimeStatusRoute(testApp.app)

    const response = await testApp.app.inject({
      method: llmRuntimeStatusApi.method,
      url: llmRuntimeStatusApi.path.replace(":provider", "openai")
    })

    expect(response.statusCode).toBe(400)
  })
})
