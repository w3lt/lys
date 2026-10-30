import { describe, expect, it } from "vitest"
import FailureRecordingLlmEngine from "../../../../src/modules/llm/failureRecordingLlmEngine"
import LlmRuntimeCallRecord from "../../../../src/modules/llm/llmRuntimeCallRecord"
import type { LoadedLlmModelInstance } from "../../../../src/modules/llm/llmRuntimeTypes"
import { createFakeLlmRuntime } from "../../support/fakeLlmRuntime"
import { createDownloadedLlmModel } from "../../support/llmFixtures"

/** Loaded identity returned by the borrowed engine in forwarding cases. */
const LOADED_INSTANCE: LoadedLlmModelInstance = Object.freeze({
  modelKey: "qwen/qwen3-8b",
  modelIdentifier: "qwen/qwen3-8b:1"
})

/**
 * Creates a recorder over a borrowed engine double and a fresh call record.
 *
 * @returns The recorder, the engine double whose calls it forwards, and the
 * record it writes to.
 */
function createRecordingEngine() {
  const engine = createFakeLlmRuntime()
  const record = new LlmRuntimeCallRecord()
  return {
    recorder: new FailureRecordingLlmEngine(engine, record),
    engine,
    record
  }
}

describe("FailureRecordingLlmEngine", () => {
  describe("forwarding", () => {
    it("forwards the downloaded inventory unchanged", async () => {
      const { recorder, engine, record } = createRecordingEngine()
      const models = Object.freeze([
        createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" })
      ])
      engine.listDownloadedLlmModels.mockResolvedValue(models)

      await expect(recorder.listDownloadedLlmModels()).resolves.toBe(models)
      expect(engine.listDownloadedLlmModels).toHaveBeenCalledOnce()
      expect(record.hasRecordedFailure).toBe(false)
    })

    it("forwards the loaded inventory unchanged", async () => {
      const { recorder, engine, record } = createRecordingEngine()
      const instances = Object.freeze([LOADED_INSTANCE])
      engine.listLoadedLlmModelInstances.mockResolvedValue(instances)

      await expect(recorder.listLoadedLlmModelInstances()).resolves.toBe(
        instances
      )
      expect(engine.listLoadedLlmModelInstances).toHaveBeenCalledOnce()
      expect(record.hasRecordedFailure).toBe(false)
    })

    it("forwards the model selection, the texts, and the measurement unchanged", async () => {
      const { recorder, engine, record } = createRecordingEngine()
      const texts = Object.freeze(["You are Lys.", "Hello"])
      const measurement = Object.freeze({
        contextLength: 8192,
        textTokenCounts: Object.freeze([4, 1])
      })
      engine.findLlmContextMeasurement.mockResolvedValue(measurement)

      await expect(
        recorder.findLlmContextMeasurement("qwen/qwen3-8b", texts)
      ).resolves.toBe(measurement)
      expect(engine.findLlmContextMeasurement).toHaveBeenCalledExactlyOnceWith(
        "qwen/qwen3-8b",
        texts
      )
      expect(record.hasRecordedFailure).toBe(false)
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
        "findLlmContextMeasurement",
        (recorder: FailureRecordingLlmEngine) =>
          recorder.findLlmContextMeasurement("qwen/qwen3-8b", ["Hello"])
      ]
    ] as const)(
      "forwards the original %s rejection and records it",
      async (operationName, callOperation) => {
        const { recorder, engine, record } = createRecordingEngine()
        const failure = new Error(`${operationName} failed`)
        engine[operationName].mockRejectedValue(failure)

        await expect(callOperation(recorder)).rejects.toBe(failure)
        expect(record.hasRecordedFailure).toBe(true)
      }
    )

    it("forwards a synchronous engine throw as a rejection and records it", async () => {
      const { recorder, engine, record } = createRecordingEngine()
      const failure = new Error("engine threw synchronously")
      engine.listLoadedLlmModelInstances.mockImplementation(() => {
        throw failure
      })

      const call = recorder.listLoadedLlmModelInstances()

      expect(call).toBeInstanceOf(Promise)
      await expect(call).rejects.toBe(failure)
      expect(record.hasRecordedFailure).toBe(true)
    })
  })
})
