import {
  createLlmServiceBusyProblem,
  llmRuntimeConnectApi,
  llmRuntimeConnectionApiResponseSchema
} from "@lys/protocol"
import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import updateFastifyWithLlmRuntimeConnectRoute from "../../../../../src/modules/llm/routes/runtimeConnectRoute"
import {
  createLlmRouteTestApp,
  type LlmRouteTestApp
} from "../../../support/llmRouteTestApp"

/**
 * Sends one runtime connection request.
 *
 * @param testApp - Application with the runtime-connect route registered.
 * @param provider - Provider the path names, as typed; LM Studio by default.
 * @returns The completed response.
 */
async function sendConnectRequest(
  testApp: LlmRouteTestApp,
  provider: string = "lmStudio"
) {
  return await testApp.app.inject({
    method: llmRuntimeConnectApi.method,
    url: llmRuntimeConnectApi.path.replace(":provider", provider)
  })
}

describe("updateFastifyWithLlmRuntimeConnectRoute", () => {
  it.each(["connected", "unreachable", "off"] as const)(
    "responds with the settled %s status of the connection attempt",
    async (status) => {
      const testApp = createLlmRouteTestApp()
      const connectLlmRuntime = vi
        .spyOn(testApp.runtimeService, "connectLlmRuntime")
        .mockResolvedValue(status)
      await updateFastifyWithLlmRuntimeConnectRoute(testApp.app)

      const response = await sendConnectRequest(testApp)

      expect(response.statusCode).toBe(200)
      expect(
        llmRuntimeConnectionApiResponseSchema.parse(response.json())
      ).toEqual({ status })
      expect(connectLlmRuntime).toHaveBeenCalledOnce()
    }
  )

  it.each(LLM_PROVIDERS)(
    "connects %s, the provider the path names, and no other provider",
    async (provider: LlmProvider) => {
      const testApp = createLlmRouteTestApp()
      const connections = LLM_PROVIDERS.map((connected) =>
        vi
          .spyOn(
            testApp.llmProviderServices[connected].llmRuntimeService,
            "connectLlmRuntime"
          )
          .mockResolvedValue("connected")
      )
      await updateFastifyWithLlmRuntimeConnectRoute(testApp.app)

      const response = await sendConnectRequest(testApp, provider)

      expect(response.statusCode).toBe(200)
      expect(
        connections.map((connection) => connection.mock.calls.length)
      ).toEqual(
        LLM_PROVIDERS.map((connected) => (connected === provider ? 1 : 0))
      )
    }
  )

  it("refuses a path that names no provider Lys can reach before any provider connects", async () => {
    const testApp = createLlmRouteTestApp()
    const connectLlmRuntime = vi.spyOn(
      testApp.runtimeService,
      "connectLlmRuntime"
    )
    await updateFastifyWithLlmRuntimeConnectRoute(testApp.app)

    const response = await sendConnectRequest(testApp, "openai")

    expect(response.statusCode).toBe(400)
    expect(connectLlmRuntime).not.toHaveBeenCalled()
  })

  it("responds with the service-busy problem when the attempt is refused", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.runtimeService, "connectLlmRuntime").mockRejectedValue(
      createLlmServiceBusyError()
    )
    await updateFastifyWithLlmRuntimeConnectRoute(testApp.app)

    const response = await sendConnectRequest(testApp)

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual(createLlmServiceBusyProblem())
  })

  it("leaves another connection failure to the application error boundary", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.runtimeService, "connectLlmRuntime").mockRejectedValue(
      new Error("The LLM runtime is closed.")
    )
    await updateFastifyWithLlmRuntimeConnectRoute(testApp.app)

    const response = await sendConnectRequest(testApp)

    expect(response.statusCode).toBe(500)
  })
})
