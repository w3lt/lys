import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import LlmService from "../../../../src/di/services/llmService"
import { isLlmServiceBusyError } from "../../../../src/modules/llm/llmServiceBusyError"
import type { LoadedLlmModelInstance } from "../../../../src/modules/llm/llmRuntimeTypes"
import { createFakeLlmRuntime } from "../../support/fakeLlmRuntime"
import { createDownloadedLlmModel } from "../../support/llmFixtures"
import { flushMicrotasks } from "../../support/microtasks"

/** Accepted operations the service admits at once: one active and eight waiting. */
const SERVICE_CAPACITY = 9

/** Message of the failure raised for work requested after cleanup begins. */
const CLOSED_MESSAGE = "The LLM runtime is closed."

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
 * Creates a service whose runtime blocks every loaded-inventory query on one gate.
 *
 * @returns The service, its runtime, and the gate releasing all queries.
 */
function createServiceWithBlockedInventory() {
  const runtime = createFakeLlmRuntime()
  const gate = Promise.withResolvers<void>()
  runtime.listLoadedLlmModelInstances.mockImplementation(async () => {
    await gate.promise
    return []
  })
  return { service: new LlmService({ runtime }), runtime, gate }
}

describe("LlmService", () => {
  describe("listLlmModels", () => {
    it("annotates downloaded models with their loaded state and orders them by key then path", async () => {
      const runtime = createFakeLlmRuntime()
      runtime.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "b/model" }),
        createDownloadedLlmModel({ modelKey: "a/model", path: "z/path.gguf" }),
        createDownloadedLlmModel({ modelKey: "a/model", path: "a/path.gguf" })
      ])
      runtime.listLoadedLlmModelInstances.mockResolvedValue([
        createLoadedInstance("b/model"),
        createLoadedInstance("unknown/model")
      ])
      const service = new LlmService({ runtime })

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
      const runtime = createFakeLlmRuntime()
      runtime.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "a/model" })
      ])
      runtime.listLoadedLlmModelInstances.mockResolvedValue([])

      const models = await new LlmService({ runtime }).listLlmModels()

      expect(Object.isFrozen(models)).toBe(true)
      expect(Object.isFrozen(models[0])).toBe(true)
    })

    it.each([
      ["downloaded", "listDownloadedLlmModels"],
      ["loaded", "listLoadedLlmModelInstances"]
    ] as const)(
      "propagates a failed %s inventory query",
      async (_label, failingQuery) => {
        const runtime = createFakeLlmRuntime()
        runtime.listDownloadedLlmModels.mockResolvedValue([])
        runtime.listLoadedLlmModelInstances.mockResolvedValue([])
        const failure = new Error("The LLM runtime could not list models.")
        runtime[failingQuery].mockRejectedValue(failure)

        await expect(new LlmService({ runtime }).listLlmModels()).rejects.toBe(
          failure
        )
      }
    )
  })

  describe("loadLlmModel", () => {
    it("loads the selection and returns the canonical model's metadata as loaded", async () => {
      const runtime = createFakeLlmRuntime()
      runtime.loadLlmModel.mockResolvedValue(
        Object.freeze({
          modelKey: "qwen/qwen3-8b",
          modelIdentifier: "qwen/qwen3-8b"
        })
      )
      runtime.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "other/model" }),
        createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" })
      ])

      const model = await new LlmService({ runtime }).loadLlmModel("qwen3")

      expect(runtime.loadLlmModel).toHaveBeenCalledWith("qwen3")
      expect(model).toEqual({
        ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
        loaded: true
      })
    })

    it("rejects when the loaded model is absent from the downloaded inventory", async () => {
      const runtime = createFakeLlmRuntime()
      runtime.loadLlmModel.mockResolvedValue(
        Object.freeze({ modelKey: "qwen/qwen3-8b", modelIdentifier: "id" })
      )
      runtime.listDownloadedLlmModels.mockResolvedValue([])

      await expect(
        new LlmService({ runtime }).loadLlmModel("qwen/qwen3-8b")
      ).rejects.toThrow(
        'Loaded model "qwen/qwen3-8b" was not found in the downloaded LLM inventory'
      )
    })

    it("propagates a load failure without querying inventory", async () => {
      const runtime = createFakeLlmRuntime()
      const failure = new Error("The LLM runtime could not load the model.")
      runtime.loadLlmModel.mockRejectedValue(failure)

      await expect(
        new LlmService({ runtime }).loadLlmModel("qwen/qwen3-8b")
      ).rejects.toBe(failure)
      expect(runtime.listDownloadedLlmModels).not.toHaveBeenCalled()
    })
  })

  describe("getLlmModelHealth", () => {
    it("reports ready with latency measured by the injected clock", async () => {
      const runtime = createFakeLlmRuntime()
      runtime.listLoadedLlmModelInstances.mockResolvedValue([
        createLoadedInstance("qwen/qwen3-8b")
      ])
      const readMonotonicTimeMs = vi
        .fn<() => number>()
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1025)
      const service = new LlmService({ runtime, readMonotonicTimeMs })

      const outcome = await service.getLlmModelHealth("qwen/qwen3-8b")

      expect(outcome).toEqual({
        health: { modelId: "qwen/qwen3-8b", status: "ready", latencyMs: 25 },
        diagnostics: []
      })
    })

    it("excludes time spent waiting behind earlier operations from latency", async () => {
      const runtime = createFakeLlmRuntime()
      const firstQuery = Promise.withResolvers<LoadedLlmModelInstance[]>()
      runtime.listLoadedLlmModelInstances
        .mockReturnValueOnce(firstQuery.promise)
        .mockResolvedValueOnce([])
      let nowMs = 0
      const service = new LlmService({
        runtime,
        readMonotonicTimeMs: () => nowMs
      })
      const first = service.getLlmModelHealth("a/model")
      const second = service.getLlmModelHealth("b/model")
      await flushMicrotasks()
      expect(runtime.listLoadedLlmModelInstances).toHaveBeenCalledOnce()

      nowMs = 500
      firstQuery.resolve([])

      await expect(first).resolves.toMatchObject({ health: { latencyMs: 500 } })
      await expect(second).resolves.toMatchObject({ health: { latencyMs: 0 } })
    })

    it("reports runtime-unavailable with the retained inventory failure", async () => {
      const runtime = createFakeLlmRuntime()
      const failure = new Error("socket closed")
      runtime.listLoadedLlmModelInstances.mockRejectedValue(failure)
      const reporter = vi.fn()

      const outcome = await new LlmService({
        runtime,
        readMonotonicTimeMs: () => 0
      }).getLlmModelHealth("qwen/qwen3-8b")

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
      const runtime = createFakeLlmRuntime()
      runtime.listLoadedLlmModelInstances.mockResolvedValue([])

      const outcome = await new LlmService({ runtime }).getLlmModelHealth(
        "qwen/qwen3-8b"
      )

      expect(Number.isSafeInteger(outcome.health.latencyMs)).toBe(true)
      expect(outcome.health.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it.each([
      ["an empty key", ""],
      ["a key longer than 100 characters", "k".repeat(101)]
    ])("rejects %s before queue admission", async (_label, modelKey) => {
      const runtime = createFakeLlmRuntime()

      await expect(
        new LlmService({ runtime }).getLlmModelHealth(modelKey)
      ).rejects.toBeInstanceOf(z.ZodError)
      expect(runtime.listLoadedLlmModelInstances).not.toHaveBeenCalled()
    })

    it("accepts a key of exactly 100 characters", async () => {
      const runtime = createFakeLlmRuntime()
      runtime.listLoadedLlmModelInstances.mockResolvedValue([])

      await expect(
        new LlmService({ runtime }).getLlmModelHealth("k".repeat(100))
      ).resolves.toMatchObject({
        health: { status: "not-ready", reason: "model-not-loaded" }
      })
    })
  })

  describe("stopLlmModelsByKey", () => {
    it("stops the key's instances through the owned runtime and reconciles", async () => {
      const runtime = createFakeLlmRuntime()
      runtime.listLoadedLlmModelInstances
        .mockResolvedValueOnce([createLoadedInstance("qwen/qwen3-8b")])
        .mockResolvedValueOnce([])
      runtime.stopLoadedLlmModelInstance.mockResolvedValue(undefined)

      const outcome = await new LlmService({ runtime }).stopLlmModelsByKey(
        "qwen/qwen3-8b"
      )

      expect(outcome).toEqual({ status: "stopped", diagnostics: [] })
      expect(runtime.stopLoadedLlmModelInstance).toHaveBeenCalledWith(
        "qwen/qwen3-8b"
      )
    })
  })

  describe("operation queue", () => {
    it("runs accepted operations one at a time in admission order", async () => {
      const runtime = createFakeLlmRuntime()
      const firstLoad = Promise.withResolvers<LoadedLlmModelInstance>()
      runtime.loadLlmModel.mockReturnValueOnce(firstLoad.promise)
      runtime.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "a/model" })
      ])
      runtime.listLoadedLlmModelInstances.mockResolvedValue([])
      const service = new LlmService({ runtime })

      const load = service.loadLlmModel("a/model")
      const list = service.listLlmModels()
      await flushMicrotasks()
      expect(runtime.loadLlmModel).toHaveBeenCalledOnce()
      expect(runtime.listLoadedLlmModelInstances).not.toHaveBeenCalled()

      firstLoad.resolve(createLoadedInstance("a/model"))
      await expect(load).resolves.toMatchObject({ modelKey: "a/model" })
      await expect(list).resolves.toHaveLength(1)
    })

    it("continues with the next operation after an operation fails", async () => {
      const runtime = createFakeLlmRuntime()
      runtime.loadLlmModel.mockRejectedValue(new Error("load failed"))
      runtime.listDownloadedLlmModels.mockResolvedValue([])
      runtime.listLoadedLlmModelInstances.mockResolvedValue([])
      const service = new LlmService({ runtime })

      const load = service.loadLlmModel("a/model")
      const list = service.listLlmModels()

      await expect(load).rejects.toThrow("load failed")
      await expect(list).resolves.toEqual([])
    })

    it("refuses an operation beyond one active and eight waiting without runtime work", async () => {
      const { service, runtime, gate } = createServiceWithBlockedInventory()
      const accepted = Array.from({ length: SERVICE_CAPACITY }, (_, index) =>
        service.getLlmModelHealth(`model-${index}`)
      )

      const refused = service.stopLlmModelsByKey("model-refused").then(
        () => "accepted",
        (error: unknown) => error
      )
      gate.resolve()
      await Promise.all(accepted)

      expect(isLlmServiceBusyError(await refused)).toBe(true)
      expect(runtime.listLoadedLlmModelInstances).toHaveBeenCalledTimes(
        SERVICE_CAPACITY
      )
      expect(runtime.stopLoadedLlmModelInstance).not.toHaveBeenCalled()
    })

    it("admits new work after accepted work settles", async () => {
      const { service, gate } = createServiceWithBlockedInventory()
      const accepted = Array.from({ length: SERVICE_CAPACITY }, (_, index) =>
        service.getLlmModelHealth(`model-${index}`)
      )
      gate.resolve()
      await Promise.all(accepted)

      await expect(
        service.getLlmModelHealth("model-next")
      ).resolves.toMatchObject({ health: { modelId: "model-next" } })
    })

    it("releases capacity held by a failed operation", async () => {
      const runtime = createFakeLlmRuntime()
      runtime.listLoadedLlmModelInstances.mockRejectedValue(
        new Error("offline")
      )
      runtime.listDownloadedLlmModels.mockRejectedValue(new Error("offline"))
      const service = new LlmService({ runtime, readMonotonicTimeMs: () => 0 })
      const failed = Array.from({ length: SERVICE_CAPACITY }, () =>
        service.listLlmModels().catch(() => undefined)
      )
      await Promise.all(failed)

      await expect(service.getLlmModelHealth("a/model")).resolves.toMatchObject(
        { health: { reason: "runtime-unavailable" } }
      )
    })
  })

  describe("disposal", () => {
    it("disposes the runtime only after accepted work settles", async () => {
      const { service, runtime, gate } = createServiceWithBlockedInventory()
      const accepted = service.getLlmModelHealth("a/model")

      const disposal = service[Symbol.asyncDispose]()
      await flushMicrotasks()
      expect(runtime[Symbol.asyncDispose]).not.toHaveBeenCalled()

      gate.resolve()
      await expect(accepted).resolves.toMatchObject({
        health: { modelId: "a/model" }
      })
      await disposal
      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
    })

    it("refuses every operation once cleanup begins", async () => {
      const runtime = createFakeLlmRuntime()
      const service = new LlmService({ runtime })

      const disposal = service[Symbol.asyncDispose]()

      await expect(service.listLlmModels()).rejects.toThrow(CLOSED_MESSAGE)
      await expect(service.loadLlmModel("a/model")).rejects.toThrow(
        CLOSED_MESSAGE
      )
      await expect(service.stopLlmModelsByKey("a/model")).rejects.toThrow(
        CLOSED_MESSAGE
      )
      await expect(service.getLlmModelHealth("")).rejects.toThrow(
        CLOSED_MESSAGE
      )
      await disposal
      await expect(service.listLlmModels()).rejects.toThrow(CLOSED_MESSAGE)
      expect(runtime.listDownloadedLlmModels).not.toHaveBeenCalled()
    })

    it("shares one runtime cleanup across concurrent and repeated calls", async () => {
      const runtime = createFakeLlmRuntime()
      const service = new LlmService({ runtime })

      await Promise.all([
        service[Symbol.asyncDispose](),
        service[Symbol.asyncDispose]()
      ])
      await service[Symbol.asyncDispose]()

      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
    })

    it("stays closed and repeats the cleanup failure without retrying release", async () => {
      const runtime = createFakeLlmRuntime()
      const failure = new Error(
        "The LLM runtime could not release its resources."
      )
      runtime[Symbol.asyncDispose].mockRejectedValue(failure)
      const service = new LlmService({ runtime })

      await expect(service[Symbol.asyncDispose]()).rejects.toBe(failure)
      await expect(service[Symbol.asyncDispose]()).rejects.toBe(failure)

      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce()
      await expect(service.listLlmModels()).rejects.toThrow(CLOSED_MESSAGE)
    })
  })
})
