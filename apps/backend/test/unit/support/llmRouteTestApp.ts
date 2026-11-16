import { vi } from "vitest"
import {
  buildLlmProviderRecord,
  type LlmProviderRecord,
  type LlmProviderServices
} from "../../../src/modules/llm/llmProviderServices"
import LlmRuntimeService from "../../../src/modules/llm/llmRuntimeService"
import LlmService, {
  type LlmEngineOperationQueue
} from "../../../src/modules/llm/llmService"
import { createTestFastify, type TestFastify } from "./fastifyTestApp"

/** Test application exposing the LLM services the LLM routes read. */
export type LlmRouteTestApp = TestFastify &
  Readonly<{
    /**
     * Each provider's services, decorated as `app.llmProviderServices`.
     * Each case stubs the one capability method its route calls; an
     * unstubbed method rejects, and no runtime service is ever connected.
     */
    llmProviderServices: LlmProviderRecord<LlmProviderServices>
    /**
     * LM Studio's LLM service, the one most cases' paths name; the same
     * service as `llmProviderServices.lmStudio.llmService`.
     */
    service: LlmService
    /**
     * LM Studio's LLM runtime service; the same service as
     * `llmProviderServices.lmStudio.llmRuntimeService`.
     */
    runtimeService: LlmRuntimeService
  }>

/**
 * Creates a test application decorated with each provider's LLM services,
 * none of which reaches a runtime.
 *
 * @returns The application, the destination of its log, each provider's
 * decorated services, and LM Studio's.
 * @remarks Each LLM service borrows an operation queue that rejects every
 * operation with `Unexpected LLM engine operation`, so a route outcome comes
 * only from the capability method a case stubs with `vi.spyOn`. Each LLM
 * runtime service holds no runtime: it is never connected, and a provider
 * lookup or an acquisition would reject with `Unexpected LLM provider
 * lookup` or `Unexpected LLM runtime acquisition`. Routes are not
 * registered; each case registers the route under test.
 */
export function createLlmRouteTestApp(): LlmRouteTestApp {
  const testFastify = createTestFastify()
  const llmProviderServices = buildLlmProviderRecord(() =>
    createUnconnectedLlmProviderServices()
  )
  testFastify.app.decorate("llmProviderServices", llmProviderServices)
  return Object.freeze({
    ...testFastify,
    llmProviderServices,
    service: llmProviderServices.lmStudio.llmService,
    runtimeService: llmProviderServices.lmStudio.llmRuntimeService
  })
}

/**
 * Creates one provider's services, which never reach a runtime.
 *
 * @returns An LLM service whose queue rejects every operation, and a runtime
 * service that is never connected.
 */
function createUnconnectedLlmProviderServices(): LlmProviderServices {
  const llmEngineOperationQueue: LlmEngineOperationQueue = Object.freeze({
    handleLlmEngineOperationRequest: () =>
      Promise.reject(new Error("Unexpected LLM engine operation"))
  })
  const llmRuntimeService = new LlmRuntimeService({
    findLlmProviderAccess: () =>
      Promise.reject(new Error("Unexpected LLM provider lookup")),
    acquireLlmRuntime: () =>
      Promise.reject(new Error("Unexpected LLM runtime acquisition")),
    reportLlmRuntimeAcquisitionFailure: vi.fn<(failure: unknown) => void>(),
    reportLlmRuntimeAvailabilityCheckFailure:
      vi.fn<(failure: unknown) => void>()
  })
  return Object.freeze({
    llmService: new LlmService({ llmEngineOperationQueue }),
    llmRuntimeService
  })
}
