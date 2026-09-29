import {
  createLlmServiceBusyProblem,
  llmRuntimeConnectApi,
  llmRuntimeConnectionApiResponseSchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import updateFastifyWithLlmRuntimeConnectRoute from "../../../../../src/modules/llm/routes/runtimeConnectRoute"
import {
  createLlmRouteTestApp,
  type LlmRouteTestApp
} from "../../../support/llmRouteTestApp"

/**
 * Requests one runtime connection attempt.
 *
 * @param testApp - Application with the runtime-connect route registered.
 * @returns The completed response.
 */
async function requestConnect(testApp: LlmRouteTestApp) {
  return await testApp.app.inject({
    method: llmRuntimeConnectApi.method,
    url: llmRuntimeConnectApi.path
  })
}

describe("updateFastifyWithLlmRuntimeConnectRoute", () => {
  it.each(["connected", "unreachable"] as const)(
    "responds with the settled %s status of the connection attempt",
    async (status) => {
      const testApp = createLlmRouteTestApp()
      const connectLlmRuntime = vi
        .spyOn(testApp.runtimeService, "connectLlmRuntime")
        .mockResolvedValue(status)
      await updateFastifyWithLlmRuntimeConnectRoute(testApp.app)

      const response = await requestConnect(testApp)

      expect(response.statusCode).toBe(200)
      expect(
        llmRuntimeConnectionApiResponseSchema.parse(response.json())
      ).toEqual({ status })
      expect(connectLlmRuntime).toHaveBeenCalledOnce()
    }
  )

  it("responds with the service-busy problem when the attempt is refused", async () => {
    const testApp = createLlmRouteTestApp()
    vi.spyOn(testApp.runtimeService, "connectLlmRuntime").mockRejectedValue(
      createLlmServiceBusyError()
    )
    await updateFastifyWithLlmRuntimeConnectRoute(testApp.app)

    const response = await requestConnect(testApp)

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

    const response = await requestConnect(testApp)

    expect(response.statusCode).toBe(500)
  })
})
