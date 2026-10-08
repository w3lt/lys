import { vi, type Mock } from "vitest"
import type { LlmEngine } from "../../../src/modules/llm/llmEngine"
import type { LlmRuntime } from "../../../src/modules/llm/llmRuntime"
import type { LlmRuntimeLifecycle } from "../../../src/modules/llm/llmRuntimeLifecycle"

/**
 * Runtime double usable wherever an `LlmRuntime` or its `LlmEngine` view is
 * accepted, with every operation observable.
 */
export type FakeLlmRuntime = LlmRuntime &
  Readonly<{
    /** Downloaded-inventory query. */
    listDownloadedLlmModels: Mock<LlmEngine["listDownloadedLlmModels"]>
    /** Loaded-inventory query. */
    listLoadedLlmModelInstances: Mock<LlmEngine["listLoadedLlmModelInstances"]>
    /** Model load command. */
    loadLlmModel: Mock<LlmEngine["loadLlmModel"]>
    /** Instance stop command. */
    stopLoadedLlmModelInstance: Mock<LlmEngine["stopLoadedLlmModelInstance"]>
    /** Provider readiness probe. */
    getRuntimeAvailability: Mock<LlmRuntimeLifecycle["getRuntimeAvailability"]>
    /** Runtime release. */
    [Symbol.asyncDispose]: Mock<() => Promise<void>>
  }>

/**
 * Creates a runtime double whose unconfigured operations fail.
 *
 * @returns Mocks that each reject with `Unexpected LLM runtime call: <name>`
 * until a case configures them, except disposal, which resolves. Reading
 * `lifecycleStatus` throws the same failure, because no consumer under test
 * is expected to observe it.
 * @remarks Failing by default keeps an operation a case did not arrange from
 * silently succeeding with an empty inventory or an available runtime.
 */
export function createFakeLlmRuntime(): FakeLlmRuntime {
  return Object.freeze({
    listDownloadedLlmModels: vi.fn<LlmEngine["listDownloadedLlmModels"]>(() =>
      Promise.reject(createUnexpectedCallError("listDownloadedLlmModels"))
    ),
    listLoadedLlmModelInstances: vi.fn<
      LlmEngine["listLoadedLlmModelInstances"]
    >(() =>
      Promise.reject(createUnexpectedCallError("listLoadedLlmModelInstances"))
    ),
    loadLlmModel: vi.fn<LlmEngine["loadLlmModel"]>(() =>
      Promise.reject(createUnexpectedCallError("loadLlmModel"))
    ),
    stopLoadedLlmModelInstance: vi.fn<LlmEngine["stopLoadedLlmModelInstance"]>(
      () =>
        Promise.reject(createUnexpectedCallError("stopLoadedLlmModelInstance"))
    ),
    getRuntimeAvailability: vi.fn<
      LlmRuntimeLifecycle["getRuntimeAvailability"]
    >(() =>
      Promise.reject(createUnexpectedCallError("getRuntimeAvailability"))
    ),
    get lifecycleStatus(): never {
      return handleUnexpectedCall("lifecycleStatus")
    },
    [Symbol.asyncDispose]: vi.fn(() => Promise.resolve())
  })
}

/**
 * Fails an operation that the current case did not arrange.
 *
 * @param operationName - Runtime operation that was called.
 * @throws Always.
 */
function handleUnexpectedCall(operationName: string): never {
  throw createUnexpectedCallError(operationName)
}

/**
 * Creates the failure for an operation that the current case did not arrange.
 *
 * @param operationName - Runtime operation that was called.
 * @returns An error with the message `Unexpected LLM runtime call: <name>`.
 */
function createUnexpectedCallError(operationName: string): Error {
  return new Error(`Unexpected LLM runtime call: ${operationName}`)
}
