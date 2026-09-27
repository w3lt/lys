import LlmService from "../../src/di/services/llmService"
import { createFakeLlmRuntime, type FakeLlmRuntime } from "./fakeLlmRuntime"
import { createTestFastify, type TestFastify } from "./fastifyTestApp"

/** Accepted operations the LLM service admits at once. */
const LLM_SERVICE_CAPACITY = 9

/** Test application exposing an LLM service backed by a runtime double. */
export type LlmRouteTestApp = TestFastify &
  Readonly<{
    /** Runtime double owned by the decorated service. */
    runtime: FakeLlmRuntime
    /** Service decorated as `app.llmService`. */
    service: LlmService
  }>

/**
 * Creates a test application decorated with an LLM service.
 *
 * @returns The application, captured logs, service, and runtime double.
 * @remarks The service's clock always reads zero, so reported latency is 0.
 * Routes are not registered; each case registers the route under test.
 */
export function createLlmRouteTestApp(): LlmRouteTestApp {
  const testFastify = createTestFastify()
  const runtime = createFakeLlmRuntime()
  const service = new LlmService({ runtime, readMonotonicTimeMs: () => 0 })
  testFastify.app.decorate("llmService", service)
  return Object.freeze({ ...testFastify, runtime, service })
}

/**
 * Fills every admission position of the service with pending health queries.
 *
 * @param testApp - Application whose service and runtime are occupied.
 * @returns A release operation that lets the queries finish and resolves after
 * all of them settle.
 * @remarks Replaces the runtime's loaded-inventory behavior for the rest of
 * the case.
 */
export function occupyLlmServiceCapacity(
  testApp: LlmRouteTestApp
): () => Promise<void> {
  const gate = Promise.withResolvers<void>()
  testApp.runtime.listLoadedLlmModelInstances.mockImplementation(async () => {
    await gate.promise
    return []
  })
  const occupied = Array.from({ length: LLM_SERVICE_CAPACITY }, (_, index) =>
    testApp.service.getLlmModelHealth(`occupying-model-${index}`)
  )
  return async () => {
    gate.resolve()
    await Promise.all(occupied)
  }
}
