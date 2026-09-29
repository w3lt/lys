import {
  llmRuntimeConnectionApiResponseSchema,
  llmRuntimeStatusApi,
  type LlmRuntimeConnectionStatus
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import updateFastifyWithLlmRuntimeStatusRoute from "../../../../../src/modules/llm/routes/runtimeStatusRoute"
import { createLlmRouteTestApp } from "../../../support/llmRouteTestApp"

describe("updateFastifyWithLlmRuntimeStatusRoute", () => {
  it.each([
    "connecting",
    "connected",
    "unreachable"
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
        url: llmRuntimeStatusApi.path
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
})
