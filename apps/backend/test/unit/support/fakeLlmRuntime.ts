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
    listDownloadedLlmModels: vi.fn<LlmEngine["listDownloadedLlmModels"]>(
      async () => rejectUnexpectedCall("listDownloadedLlmModels")
    ),
    listLoadedLlmModelInstances: vi.fn<
      LlmEngine["listLoadedLlmModelInstances"]
    >(async () => rejectUnexpectedCall("listLoadedLlmModelInstances")),
    loadLlmModel: vi.fn<LlmEngine["loadLlmModel"]>(async () =>
      rejectUnexpectedCall("loadLlmModel")
    ),
    stopLoadedLlmModelInstance: vi.fn<LlmEngine["stopLoadedLlmModelInstance"]>(
      async () => rejectUnexpectedCall("stopLoadedLlmModelInstance")
    ),
    getRuntimeAvailability: vi.fn<
      LlmRuntimeLifecycle["getRuntimeAvailability"]
    >(async () => rejectUnexpectedCall("getRuntimeAvailability")),
    get lifecycleStatus(): never {
      return rejectUnexpectedCall("lifecycleStatus")
    },
    [Symbol.asyncDispose]: vi.fn(async () => undefined)
  })
}

/**
 * Rejects an operation that the current case did not arrange.
 *
 * @param operationName - Runtime operation that was called.
 * @throws Always.
 */
function rejectUnexpectedCall(operationName: string): never {
  throw new Error(`Unexpected LLM runtime call: ${operationName}`)
}
