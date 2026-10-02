import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import LlmService, {
  type LlmEngineOperation,
  type LlmEngineOperationQueue,
  type LlmServiceCreationOptions
} from "../../../../src/di/services/llmService"
import type { LlmEngine } from "../../../../src/modules/llm/llmEngine"
import type { LoadedLlmModelInstance } from "../../../../src/modules/llm/llmRuntimeTypes"
import { createFakeLlmRuntime } from "../../support/fakeLlmRuntime"
import { createDownloadedLlmModel } from "../../support/llmFixtures"
import { flushMicrotasks } from "../../support/microtasks"

/** Service settings a case may vary; the queue is always the case's double. */
type LlmServiceTestOptions = Omit<
  LlmServiceCreationOptions,
  "llmEngineOperationQueue"
>

/**
 * Creates one loaded-instance observation.
 *
 * @param modelKey - Canonical key, also used as the instance identifier.
 * @returns The frozen observation.
 */
function createLoadedInstance(modelKey: string): LoadedLlmModelInstance {
  return Object.freeze({ modelKey, modelIdentifier: modelKey })
}

/**
 * Creates a queue that admits every operation and runs it against one engine.
 *
 * @param llmEngine - Engine handed to every admitted operation.
 * @param waitForAdmission - Settles when an admitted operation may start;
 * defaults to starting at once.
 * @returns The queue and a spy recording every operation request.
 * @remarks Cases that use it issue one operation at a time, so starting an
 * admitted operation without waiting for others preserves the queue's
 * one-at-a-time guarantee. The operation's own result or failure is returned
 * unchanged, as the queue contract requires.
 */
function createAdmittingQueue(
  llmEngine: LlmEngine,
  waitForAdmission: () => Promise<void> = async () => undefined
) {
  const queue = {
    async handleLlmEngineOperationRequest<Result>(
      operation: LlmEngineOperation<Result>
    ): Promise<Result> {
      await waitForAdmission()
      return await operation(llmEngine)
    }
  } satisfies LlmEngineOperationQueue
  const requests = vi.spyOn(queue, "handleLlmEngineOperationRequest")
  return { queue, requests }
}

/**
 * Creates a service whose admitting queue runs operations on a runtime double.
 *
 * @param options - Optional clock; every other setting is the default.
 * @returns The service, the runtime double acting as its engine, and the spy
 * recording queue requests.
 */
function createServiceWithEngine(options: LlmServiceTestOptions = {}) {
  const engine = createFakeLlmRuntime()
  const { queue, requests } = createAdmittingQueue(engine)
  const service = new LlmService({ ...options, llmEngineOperationQueue: queue })
  return { service, engine, requests }
}

/** Public model operations that each enter the borrowed queue. */
type QueuedLlmServiceOperationName = keyof Pick<
  LlmService,
  "listLlmModels" | "loadLlmModel" | "getLlmModelHealth" | "stopLlmModelsByKey"
>

/**
 * Calls one service operation with a valid argument.
 *
 * @param service - Service under test.
 * @param operationName - Public operation to call.
 * @returns The operation's settlement.
 */
async function callLlmServiceOperation(
  service: LlmService,
  operationName: QueuedLlmServiceOperationName
): Promise<unknown> {
  switch (operationName) {
    case "listLlmModels":
      return await service.listLlmModels()
    case "loadLlmModel":
      return await service.loadLlmModel("a/model")
    case "getLlmModelHealth":
      return await service.getLlmModelHealth("a/model")
    case "stopLlmModelsByKey":
      return await service.stopLlmModelsByKey("a/model")
  }
}

describe("LlmService", () => {
  describe("listLlmModels", () => {
    it("annotates downloaded models with their loaded state and orders them by key then path", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "b/model" }),
        createDownloadedLlmModel({ modelKey: "a/model", path: "z/path.gguf" }),
        createDownloadedLlmModel({ modelKey: "a/model", path: "a/path.gguf" })
      ])
      engine.listLoadedLlmModelInstances.mockResolvedValue([
        createLoadedInstance("b/model"),
        createLoadedInstance("unknown/model")
      ])

      const models = await service.listLlmModels()

      expect(
        models.map(({ modelKey, path, loaded }) => ({ modelKey, path, loaded }))
      ).toEqual([
        { modelKey: "a/model", path: "a/path.gguf", loaded: false },
        { modelKey: "a/model", path: "z/path.gguf", loaded: false },
        { modelKey: "b/model", path: "b/model/model.gguf", loaded: true }
      ])
      expect(models[2]).toEqual({
        ...createDownloadedLlmModel({ modelKey: "b/model" }),
        loaded: true
      })
    })

    it("returns a frozen inventory", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "a/model" })
      ])
      engine.listLoadedLlmModelInstances.mockResolvedValue([])

      const models = await service.listLlmModels()

      expect(Object.isFrozen(models)).toBe(true)
      expect(Object.isFrozen(models[0])).toBe(true)
    })

    it.each([
      ["downloaded", "listDownloadedLlmModels"],
      ["loaded", "listLoadedLlmModelInstances"]
    ] as const)(
      "propagates a failed %s inventory query",
      async (_label, failingQuery) => {
        const { service, engine } = createServiceWithEngine()
        engine.listDownloadedLlmModels.mockResolvedValue([])
        engine.listLoadedLlmModelInstances.mockResolvedValue([])
        const failure = new Error("The LLM runtime could not list models.")
        engine[failingQuery].mockRejectedValue(failure)

        await expect(service.listLlmModels()).rejects.toBe(failure)
      }
    )
  })

  describe("loadLlmModel", () => {
    it("loads the selection and returns the canonical model's metadata as loaded", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.loadLlmModel.mockResolvedValue(
        Object.freeze({
          modelKey: "qwen/qwen3-8b",
          modelIdentifier: "qwen/qwen3-8b"
        })
      )
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "other/model" }),
        createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" })
      ])

      const model = await service.loadLlmModel("qwen3")

      expect(engine.loadLlmModel).toHaveBeenCalledWith("qwen3")
      expect(model).toEqual({
        ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
        loaded: true
      })
    })

    it("rejects when the loaded model is absent from the downloaded inventory", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.loadLlmModel.mockResolvedValue(
        Object.freeze({ modelKey: "qwen/qwen3-8b", modelIdentifier: "id" })
      )
      engine.listDownloadedLlmModels.mockResolvedValue([])

      await expect(service.loadLlmModel("qwen/qwen3-8b")).rejects.toThrow(
        'Loaded model "qwen/qwen3-8b" was not found in the downloaded LLM inventory'
      )
    })

    it("propagates a load failure without querying inventory", async () => {
      const { service, engine } = createServiceWithEngine()
      const failure = new Error("The LLM runtime could not load the model.")
      engine.loadLlmModel.mockRejectedValue(failure)

      await expect(service.loadLlmModel("qwen/qwen3-8b")).rejects.toBe(failure)
      expect(engine.listDownloadedLlmModels).not.toHaveBeenCalled()
    })
  })

  describe("getLlmModelHealth", () => {
    it("reports ready with latency measured by the injected clock", async () => {
      const readMonotonicTimeMs = vi
        .fn<() => number>()
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1025)
      const { service, engine } = createServiceWithEngine({
        readMonotonicTimeMs
      })
      engine.listLoadedLlmModelInstances.mockResolvedValue([
        createLoadedInstance("qwen/qwen3-8b")
      ])

      const outcome = await service.getLlmModelHealth("qwen/qwen3-8b")

      expect(outcome).toEqual({
        health: { modelId: "qwen/qwen3-8b", status: "ready", latencyMs: 25 },
        diagnostics: []
      })
    })

    it("excludes time spent waiting in the queue from latency", async () => {
      const engine = createFakeLlmRuntime()
      const admission = Promise.withResolvers<void>()
      const inventoryQuery = Promise.withResolvers<LoadedLlmModelInstance[]>()
      engine.listLoadedLlmModelInstances.mockReturnValueOnce(
        inventoryQuery.promise
      )
      const { queue } = createAdmittingQueue(
        engine,
        async () => await admission.promise
      )
      let nowMs = 0
      const service = new LlmService({
        llmEngineOperationQueue: queue,
        readMonotonicTimeMs: () => nowMs
      })

      const health = service.getLlmModelHealth("a/model")
      await flushMicrotasks()
      nowMs = 500
      admission.resolve()
      await flushMicrotasks()
      expect(engine.listLoadedLlmModelInstances).toHaveBeenCalledOnce()
      nowMs = 525
      inventoryQuery.resolve([])

      await expect(health).resolves.toMatchObject({ health: { latencyMs: 25 } })
    })

    it("reports runtime-unavailable with the retained inventory failure", async () => {
      const { service, engine } = createServiceWithEngine({
        readMonotonicTimeMs: () => 0
      })
      const failure = new Error("socket closed")
      engine.listLoadedLlmModelInstances.mockRejectedValue(failure)
      const reporter = vi.fn()

      const outcome = await service.getLlmModelHealth("qwen/qwen3-8b")

      expect(outcome.health).toEqual({
        modelId: "qwen/qwen3-8b",
        status: "not-ready",
        reason: "runtime-unavailable",
        latencyMs: 0
      })
      outcome.diagnostics[0]?.handleLlmModelHealthFailureReport(reporter)
      expect(reporter.mock.calls[0]?.[0]).toBe(failure)
    })

    it("measures latency with the process clock by default", async () => {
      // The query reads the clock once before and once after the inventory
      // call, so only the process performance clock yields these readings.
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1025)
      const { service, engine } = createServiceWithEngine()
      engine.listLoadedLlmModelInstances.mockResolvedValue([])

      const outcome = await service.getLlmModelHealth("qwen/qwen3-8b")

      expect(outcome.health.latencyMs).toBe(25)
    })

    it.each([
      ["an empty key", ""],
      ["a key longer than 100 characters", "k".repeat(101)]
    ])("rejects %s before queue admission", async (_label, modelKey) => {
      const { service, requests } = createServiceWithEngine()

      await expect(service.getLlmModelHealth(modelKey)).rejects.toBeInstanceOf(
        z.ZodError
      )
      expect(requests).not.toHaveBeenCalled()
    })

    it("accepts a key of exactly 100 characters", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.listLoadedLlmModelInstances.mockResolvedValue([])

      await expect(
        service.getLlmModelHealth("k".repeat(100))
      ).resolves.toMatchObject({
        health: { status: "not-ready", reason: "model-not-loaded" }
      })
    })
  })

  describe("stopLlmModelsByKey", () => {
    it("stops the key's instances through the queued engine and reconciles", async () => {
      const { service, engine, requests } = createServiceWithEngine()
      engine.listLoadedLlmModelInstances
        .mockResolvedValueOnce([createLoadedInstance("qwen/qwen3-8b")])
        .mockResolvedValueOnce([])
      engine.stopLoadedLlmModelInstance.mockResolvedValue(undefined)

      const outcome = await service.stopLlmModelsByKey("qwen/qwen3-8b")

      expect(outcome).toEqual({ status: "stopped", diagnostics: [] })
      expect(engine.stopLoadedLlmModelInstance).toHaveBeenCalledWith(
        "qwen/qwen3-8b"
      )
      expect(requests).toHaveBeenCalledOnce()
    })
  })

  describe("queue rejection", () => {
    it.each([
      "listLlmModels",
      "loadLlmModel",
      "getLlmModelHealth",
      "stopLlmModelsByKey"
    ] as const)(
      "propagates the queue's rejection from %s without engine work",
      async (operationName) => {
        const { service, engine, requests } = createServiceWithEngine()
        const refusal = new Error("The LLM runtime is closed.")
        requests.mockRejectedValue(refusal)

        await expect(
          callLlmServiceOperation(service, operationName)
        ).rejects.toBe(refusal)
        expect(requests).toHaveBeenCalledOnce()
        expect(engine.listDownloadedLlmModels).not.toHaveBeenCalled()
        expect(engine.listLoadedLlmModelInstances).not.toHaveBeenCalled()
        expect(engine.loadLlmModel).not.toHaveBeenCalled()
        expect(engine.stopLoadedLlmModelInstance).not.toHaveBeenCalled()
      }
    )
  })
})
