import { vi } from "vitest"
import LlmRuntimeService from "../../../src/di/services/llmRuntimeService"
import LlmService, {
  type LlmEngineOperationQueue
} from "../../../src/di/services/llmService"
import { createTestFastify, type TestFastify } from "./fastifyTestApp"

/** Test application exposing the LLM services the LLM routes read. */
export type LlmRouteTestApp = TestFastify &
  Readonly<{
    /**
     * Service decorated as `app.llmService`. Each case stubs the one capability
     * method its route calls; an unstubbed method rejects.
     */
    service: LlmService
  }>

/**
 * Creates a test application decorated with LLM services that never reach a
 * runtime.
 *
 * @returns The application, captured logs, and the decorated LLM service.
 * @remarks `app.llmService` borrows an operation queue that rejects every
 * operation with `Unexpected LLM engine operation`, so a route outcome comes
 * only from the capability method a case stubs with `vi.spyOn`.
 * `app.llmRuntimeService` holds no runtime: it is never connected, and an
 * acquisition would reject with `Unexpected LLM runtime acquisition`. Routes
 * are not registered; each case registers the route under test.
 */
export function createLlmRouteTestApp(): LlmRouteTestApp {
  const testFastify = createTestFastify()
  const llmEngineOperationQueue: LlmEngineOperationQueue = Object.freeze({
    handleLlmEngineOperationRequest: async () => {
      throw new Error("Unexpected LLM engine operation")
    }
  })
  const service = new LlmService({ llmEngineOperationQueue })
  testFastify.app.decorate("llmService", service)
  testFastify.app.decorate(
    "llmRuntimeService",
    new LlmRuntimeService({
      acquireLlmRuntime: async () => {
        throw new Error("Unexpected LLM runtime acquisition")
      },
      reportLlmRuntimeAcquisitionFailure: vi.fn<(failure: unknown) => void>(),
      reportLlmRuntimeAvailabilityCheckFailure:
        vi.fn<(failure: unknown) => void>()
    })
  )
  return Object.freeze({ ...testFastify, service })
}
