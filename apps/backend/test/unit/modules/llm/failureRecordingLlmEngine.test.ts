import { describe, expect, it } from "vitest"
import FailureRecordingLlmEngine from "../../../../src/modules/llm/failureRecordingLlmEngine"
import type { LoadedLlmModelInstance } from "../../../../src/modules/llm/llmRuntimeTypes"
import { createFakeLlmRuntime } from "../../support/fakeLlmRuntime"
import { createDownloadedLlmModel } from "../../support/llmFixtures"

/** Loaded identity returned by the borrowed engine in forwarding cases. */
const LOADED_INSTANCE: LoadedLlmModelInstance = Object.freeze({
  modelKey: "qwen/qwen3-8b",
  modelIdentifier: "qwen/qwen3-8b:1"
})

/**
 * Creates a recorder over a borrowed engine double.
 *
 * @returns The recorder and the engine double whose calls it forwards.
 */
function createRecordingEngine() {
  const engine = createFakeLlmRuntime()
  return { recorder: new FailureRecordingLlmEngine(engine), engine }
}

describe("FailureRecordingLlmEngine", () => {
  it("starts with no recorded failure", () => {
    const { recorder } = createRecordingEngine()

    expect(recorder.hasRecordedFailure).toBe(false)
  })

  describe("forwarding", () => {
    it("forwards the downloaded inventory unchanged", async () => {
      const { recorder, engine } = createRecordingEngine()
      const models = Object.freeze([
        createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" })
      ])
      engine.listDownloadedLlmModels.mockResolvedValue(models)

      await expect(recorder.listDownloadedLlmModels()).resolves.toBe(models)
      expect(engine.listDownloadedLlmModels).toHaveBeenCalledOnce()
      expect(recorder.hasRecordedFailure).toBe(false)
    })

    it("forwards the loaded inventory unchanged", async () => {
      const { recorder, engine } = createRecordingEngine()
      const instances = Object.freeze([LOADED_INSTANCE])
      engine.listLoadedLlmModelInstances.mockResolvedValue(instances)

      await expect(recorder.listLoadedLlmModelInstances()).resolves.toBe(
        instances
      )
      expect(engine.listLoadedLlmModelInstances).toHaveBeenCalledOnce()
      expect(recorder.hasRecordedFailure).toBe(false)
    })

    it("forwards the model selection, the load settings, and the loaded identity unchanged", async () => {
      const { recorder, engine } = createRecordingEngine()
      const loadConfiguration = Object.freeze({ contextLength: 16_384 })
      engine.loadLlmModel.mockResolvedValue(LOADED_INSTANCE)

      await expect(
        recorder.loadLlmModel("qwen3", loadConfiguration)
      ).resolves.toBe(LOADED_INSTANCE)
      expect(engine.loadLlmModel).toHaveBeenCalledExactlyOnceWith(
        "qwen3",
        loadConfiguration
      )
      expect(recorder.hasRecordedFailure).toBe(false)
    })

    it("forwards the instance identifier and resolves after the stop", async () => {
      const { recorder, engine } = createRecordingEngine()
      engine.stopLoadedLlmModelInstance.mockResolvedValue(undefined)

      await expect(
        recorder.stopLoadedLlmModelInstance("qwen/qwen3-8b:1")
      ).resolves.toBeUndefined()
      expect(engine.stopLoadedLlmModelInstance).toHaveBeenCalledExactlyOnceWith(
        "qwen/qwen3-8b:1"
      )
      expect(recorder.hasRecordedFailure).toBe(false)
    })
  })

  describe("failure recording", () => {
    it.each([
      [
        "listDownloadedLlmModels",
        (recorder: FailureRecordingLlmEngine) =>
          recorder.listDownloadedLlmModels()
      ],
      [
        "listLoadedLlmModelInstances",
        (recorder: FailureRecordingLlmEngine) =>
          recorder.listLoadedLlmModelInstances()
      ],
      [
        "loadLlmModel",
        (recorder: FailureRecordingLlmEngine) =>
          recorder.loadLlmModel("qwen3", {})
      ],
      [
        "stopLoadedLlmModelInstance",
        (recorder: FailureRecordingLlmEngine) =>
          recorder.stopLoadedLlmModelInstance("qwen/qwen3-8b:1")
      ]
    ] as const)(
      "forwards the original %s rejection and records it",
      async (operationName, callOperation) => {
        const { recorder, engine } = createRecordingEngine()
        const failure = new Error(`${operationName} failed`)
        engine[operationName].mockRejectedValue(failure)

        await expect(callOperation(recorder)).rejects.toBe(failure)
        expect(recorder.hasRecordedFailure).toBe(true)
      }
    )

    it("forwards a synchronous engine throw as a rejection and records it", async () => {
      const { recorder, engine } = createRecordingEngine()
      const failure = new Error("engine threw synchronously")
      engine.listLoadedLlmModelInstances.mockImplementation(() => {
        throw failure
      })

      const call = recorder.listLoadedLlmModelInstances()

      expect(call).toBeInstanceOf(Promise)
      await expect(call).rejects.toBe(failure)
      expect(recorder.hasRecordedFailure).toBe(true)
    })

    it("keeps the failure recorded after later calls succeed", async () => {
      const { recorder, engine } = createRecordingEngine()
      const failure = new Error("load failed")
      engine.loadLlmModel.mockRejectedValueOnce(failure)
      engine.listLoadedLlmModelInstances.mockResolvedValue([LOADED_INSTANCE])

      await expect(recorder.loadLlmModel("qwen3", {})).rejects.toBe(failure)
      await expect(recorder.listLoadedLlmModelInstances()).resolves.toEqual([
        LOADED_INSTANCE
      ])

      expect(recorder.hasRecordedFailure).toBe(true)
    })

    it("records failures only for the recorder whose call rejected", async () => {
      const engine = createFakeLlmRuntime()
      const failure = new Error("inventory failed")
      engine.listDownloadedLlmModels.mockRejectedValueOnce(failure)
      const failedOperation = new FailureRecordingLlmEngine(engine)
      const laterOperation = new FailureRecordingLlmEngine(engine)

      await expect(failedOperation.listDownloadedLlmModels()).rejects.toBe(
        failure
      )

      expect(failedOperation.hasRecordedFailure).toBe(true)
      expect(laterOperation.hasRecordedFailure).toBe(false)
    })
  })
})
