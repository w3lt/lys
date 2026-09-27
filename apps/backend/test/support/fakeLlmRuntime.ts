import { vi, type Mock } from "vitest"
import type { LlmEngine } from "../../src/modules/llm/llmEngine"

/** Runtime double accepted by `LlmService`, with every operation observable. */
export type FakeLlmRuntime = Readonly<{
  /** Downloaded-inventory query. */
  listDownloadedLlmModels: Mock<LlmEngine["listDownloadedLlmModels"]>
  /** Loaded-inventory query. */
  listLoadedLlmModelInstances: Mock<LlmEngine["listLoadedLlmModelInstances"]>
  /** Model load command. */
  loadLlmModel: Mock<LlmEngine["loadLlmModel"]>
  /** Instance stop command. */
  stopLoadedLlmModelInstance: Mock<LlmEngine["stopLoadedLlmModelInstance"]>
  /** Runtime release. */
  [Symbol.asyncDispose]: Mock<() => Promise<void>>
}>

/**
 * Creates a runtime double whose unconfigured operations reject.
 *
 * @returns Mocks that each reject with `Unexpected LLM runtime call: <name>`
 * until a case configures them, except disposal, which resolves.
 * @remarks Rejecting by default keeps an operation a case did not arrange from
 * silently succeeding with an empty inventory.
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
