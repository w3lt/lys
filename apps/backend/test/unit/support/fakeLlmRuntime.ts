import { vi, type Mock } from "vitest"
import type { LlmEngine } from "../../../src/modules/llm/llmEngine"
import type { LlmModelInstanceController } from "../../../src/modules/llm/llmModelInstanceController"
import type {
  AcquiredLlmRuntime,
  LlmRuntime
} from "../../../src/modules/llm/llmRuntime"
import type { LlmRuntimeLifecycle } from "../../../src/modules/llm/llmRuntimeLifecycle"
import type { ConnectedLlmEngine } from "../../../src/modules/llm/llmService"

/**
 * Runtime double usable wherever an `LlmRuntime`, its `LlmEngine` view, or a
 * model-loading `LlmModelInstanceController` is accepted, with every
 * operation observable.
 */
export type FakeLlmRuntime = LlmRuntime &
  LlmModelInstanceController &
  Readonly<{
    /** Downloaded-inventory query. */
    listDownloadedLlmModels: Mock<LlmEngine["listDownloadedLlmModels"]>
    /** Loaded-inventory query. */
    listLoadedLlmModelInstances: Mock<LlmEngine["listLoadedLlmModelInstances"]>
    /** Model load command. */
    loadLlmModel: Mock<LlmModelInstanceController["loadLlmModel"]>
    /** Instance stop command. */
    stopLoadedLlmModelInstance: Mock<
      LlmModelInstanceController["stopLoadedLlmModelInstance"]
    >
    /** Context measurement query. */
    findLlmContextMeasurement: Mock<LlmEngine["findLlmContextMeasurement"]>
    /** Provider readiness probe. */
    getRuntimeAvailability: Mock<LlmRuntimeLifecycle["getRuntimeAvailability"]>
    /** Runtime release. */
    [Symbol.asyncDispose]: Mock<() => Promise<void>>
  }>

/**
 * Creates a runtime double whose unconfigured operations fail.
 *
 * @returns Mocks that each reject with `Unexpected LLM runtime call: <name>`
 * until a case configures them, except disposal, which resolves.
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
    loadLlmModel: vi.fn<LlmModelInstanceController["loadLlmModel"]>(() =>
      Promise.reject(createUnexpectedCallError("loadLlmModel"))
    ),
    stopLoadedLlmModelInstance: vi.fn<
      LlmModelInstanceController["stopLoadedLlmModelInstance"]
    >(() =>
      Promise.reject(createUnexpectedCallError("stopLoadedLlmModelInstance"))
    ),
    findLlmContextMeasurement: vi.fn<LlmEngine["findLlmContextMeasurement"]>(
      () =>
        Promise.reject(createUnexpectedCallError("findLlmContextMeasurement"))
    ),
    getRuntimeAvailability: vi.fn<
      LlmRuntimeLifecycle["getRuntimeAvailability"]
    >(() =>
      Promise.reject(createUnexpectedCallError("getRuntimeAvailability"))
    ),
    [Symbol.asyncDispose]: vi.fn(() => Promise.resolve())
  })
}

/**
 * Presents a runtime double as an acquired runtime.
 *
 * @param runtime - Double held as the runtime, and as its model-loading
 * capability when Lys loads its models.
 * @param modelLoading - Who loads the double's models; `lys` by default.
 * @returns The acquisition the runtime service receives.
 */
export function createAcquiredFakeLlmRuntime(
  runtime: FakeLlmRuntime,
  modelLoading: AcquiredLlmRuntime["modelLoading"] = "lys"
): AcquiredLlmRuntime {
  return modelLoading === "lys"
    ? Object.freeze({
        modelLoading,
        llmRuntime: runtime,
        llmModelInstanceController: runtime
      })
    : Object.freeze({ modelLoading, llmRuntime: runtime })
}

/**
 * Presents a runtime double as the connected engine one model operation
 * receives.
 *
 * @param runtime - Double used as the engine, and as its model-loading
 * capability when Lys loads its models.
 * @param modelLoading - Who loads the double's models; `lys` by default.
 * @returns The view a queued operation receives.
 */
export function createConnectedFakeLlmEngine(
  runtime: FakeLlmRuntime,
  modelLoading: ConnectedLlmEngine["modelLoading"] = "lys"
): ConnectedLlmEngine {
  return modelLoading === "lys"
    ? Object.freeze({
        modelLoading,
        llmEngine: runtime,
        llmModelInstanceController: runtime
      })
    : Object.freeze({ modelLoading, llmEngine: runtime })
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
