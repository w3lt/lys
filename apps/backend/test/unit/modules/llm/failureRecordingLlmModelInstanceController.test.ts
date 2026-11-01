import { describe, expect, it } from "vitest"
import FailureRecordingLlmModelInstanceController from "../../../../src/modules/llm/failureRecordingLlmModelInstanceController"
import LlmRuntimeCallRecord from "../../../../src/modules/llm/llmRuntimeCallRecord"
import type { LoadedLlmModelInstance } from "../../../../src/modules/llm/llmRuntimeTypes"
import { createFakeLlmRuntime } from "../../support/fakeLlmRuntime"

/** Loaded identity returned by the borrowed controller in forwarding cases. */
const LOADED_INSTANCE: LoadedLlmModelInstance = Object.freeze({
  modelKey: "qwen/qwen3-8b",
  modelIdentifier: "qwen/qwen3-8b:1"
})

/**
 * Creates a recorder over a borrowed controller double and a fresh call record.
 *
 * @returns The recorder, the controller double whose calls it forwards, and
 * the record it writes to.
 */
function createRecordingController() {
  const controller = createFakeLlmRuntime()
  const record = new LlmRuntimeCallRecord()
  return {
    recorder: new FailureRecordingLlmModelInstanceController(
      controller,
      record
    ),
    controller,
    record
  }
}

describe("FailureRecordingLlmModelInstanceController", () => {
  it("forwards the model selection, the load settings, and the loaded identity unchanged", async () => {
    const { recorder, controller, record } = createRecordingController()
    const loadConfiguration = Object.freeze({ contextLength: 16_384 })
    controller.loadLlmModel.mockResolvedValue(LOADED_INSTANCE)

    await expect(
      recorder.loadLlmModel("qwen3", loadConfiguration)
    ).resolves.toBe(LOADED_INSTANCE)
    expect(controller.loadLlmModel).toHaveBeenCalledExactlyOnceWith(
      "qwen3",
      loadConfiguration
    )
    expect(record.hasRecordedFailure).toBe(false)
  })

  it("forwards the instance identifier and resolves after the stop", async () => {
    const { recorder, controller, record } = createRecordingController()
    controller.stopLoadedLlmModelInstance.mockResolvedValue(undefined)

    await expect(
      recorder.stopLoadedLlmModelInstance("qwen/qwen3-8b:1")
    ).resolves.toBeUndefined()
    expect(
      controller.stopLoadedLlmModelInstance
    ).toHaveBeenCalledExactlyOnceWith("qwen/qwen3-8b:1")
    expect(record.hasRecordedFailure).toBe(false)
  })

  it.each([
    [
      "loadLlmModel",
      (recorder: FailureRecordingLlmModelInstanceController) =>
        recorder.loadLlmModel("qwen3", {})
    ],
    [
      "stopLoadedLlmModelInstance",
      (recorder: FailureRecordingLlmModelInstanceController) =>
        recorder.stopLoadedLlmModelInstance("qwen/qwen3-8b:1")
    ]
  ] as const)(
    "forwards the original %s rejection and records it",
    async (operationName, callOperation) => {
      const { recorder, controller, record } = createRecordingController()
      const failure = new Error(`${operationName} failed`)
      controller[operationName].mockRejectedValue(failure)

      await expect(callOperation(recorder)).rejects.toBe(failure)
      expect(record.hasRecordedFailure).toBe(true)
    }
  )
})
