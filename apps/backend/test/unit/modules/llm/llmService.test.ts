import { describe, expect, it, onTestFinished, vi } from "vitest"
import * as z from "zod"
import LlmService, {
  type LlmEngineOperation,
  type LlmEngineOperationQueue,
  type LlmServiceCreationOptions
} from "../../../../src/modules/llm/llmService"
import type { LlmEngine } from "../../../../src/modules/llm/llmEngine"
import type { LoadedLlmModelInstance } from "../../../../src/modules/llm/llmRuntimeTypes"
import LmStudioRuntime from "../../../../src/modules/llm/runtimes/lmStudioRuntime"
import { createFakeLlmRuntime } from "../../support/fakeLlmRuntime"
import InMemoryLysLlmInstanceStore from "../../support/inMemoryLysLlmInstanceStore"
import {
  createDownloadedLlmModel,
  createLmStudioLlmRecord
} from "../../support/llmFixtures"
import {
  DISCARDING_SDK_LOGGER,
  fakeLmStudio
} from "../../support/lmStudioSdkFake"
import { waitForMicrotasks } from "../../support/microtasks"

vi.mock("@lmstudio/sdk", () => import("../../support/lmStudioSdkFake"))

/**
 * Service settings a case may vary; the queue is always the case's double,
 * and the record is an in-memory one, empty unless the case gives its own.
 */
type LlmServiceTestOptions = Omit<
  LlmServiceCreationOptions,
  "llmEngineOperationQueue" | "lysLlmInstanceStore"
> &
  Readonly<{
    /** Record the service reads and saves. */
    lysLlmInstanceStore?: InMemoryLysLlmInstanceStore
  }>

/** Random part of the identifiers the services of these cases build. */
const TEST_INSTANCE_SUFFIX = "7f3c9a"

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
 * @param options - Optional clock, record, and suffix generator; the record
 * is empty and the suffix {@link TEST_INSTANCE_SUFFIX} unless given.
 * @returns The service, the runtime double acting as its engine, the record,
 * and the spy recording queue requests.
 */
function createServiceWithEngine(options: LlmServiceTestOptions = {}) {
  const engine = createFakeLlmRuntime()
  const { queue, requests } = createAdmittingQueue(engine)
  const lysLlmInstanceStore =
    options.lysLlmInstanceStore ?? new InMemoryLysLlmInstanceStore()
  const service = new LlmService({
    createLysInstanceSuffix: () => TEST_INSTANCE_SUFFIX,
    ...options,
    lysLlmInstanceStore,
    llmEngineOperationQueue: queue
  })
  return { service, engine, requests, lysLlmInstanceStore }
}

/**
 * Creates a record that already holds identifiers, as one saved before a
 * restart.
 *
 * @param instanceIdentifiers - Saved identifiers.
 * @returns The record.
 */
function createSavedRecord(
  ...instanceIdentifiers: readonly string[]
): InMemoryLysLlmInstanceStore {
  return new InMemoryLysLlmInstanceStore({
    status: "read",
    instanceIdentifiers: new Set(instanceIdentifiers)
  })
}

/** Public model operations that each enter the borrowed queue. */
type QueuedLlmServiceOperationName = keyof Pick<
  LlmService,
  | "listLlmModels"
  | "listDownloadedLlmModels"
  | "loadLlmModel"
  | "getLlmModelHealth"
  | "stopLlmModelsByKey"
  | "findLlmContextMeasurement"
>

/**
 * Sends one request to a public service operation with a valid argument.
 *
 * @param service - Service under test.
 * @param operationName - Public operation to call.
 * @returns The operation's settlement.
 */
async function sendLlmServiceRequest(
  service: LlmService,
  operationName: QueuedLlmServiceOperationName
): Promise<unknown> {
  switch (operationName) {
    case "listLlmModels":
      return await service.listLlmModels()
    case "listDownloadedLlmModels":
      return await service.listDownloadedLlmModels()
    case "loadLlmModel":
      return await service.loadLlmModel("a/model", {})
    case "getLlmModelHealth":
      return await service.getLlmModelHealth("a/model")
    case "stopLlmModelsByKey":
      return await service.stopLlmModelsByKey("a/model")
    case "findLlmContextMeasurement":
      return await service.findLlmContextMeasurement("a/model", ["Hello"])
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
      engine.findLlmContextMeasurement.mockResolvedValue({
        contextLength: 8192,
        textTokenCounts: []
      })

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
        loaded: true,
        loadedContextLength: 8192
      })
    })

    it("gives every entry of a loaded model the context length one measurement of its key reports, without text, and none to a model that is not loaded", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "a/model", path: "a/path.gguf" }),
        createDownloadedLlmModel({ modelKey: "a/model", path: "z/path.gguf" }),
        createDownloadedLlmModel({ modelKey: "b/model" })
      ])
      engine.listLoadedLlmModelInstances.mockResolvedValue([
        createLoadedInstance("a/model"),
        createLoadedInstance("unknown/model")
      ])
      engine.findLlmContextMeasurement.mockResolvedValue({
        contextLength: 4096,
        textTokenCounts: []
      })

      const models = await service.listLlmModels()

      expect(
        models.map(({ modelKey, loadedContextLength }) => ({
          modelKey,
          loadedContextLength
        }))
      ).toEqual([
        { modelKey: "a/model", loadedContextLength: 4096 },
        { modelKey: "a/model", loadedContextLength: 4096 },
        { modelKey: "b/model", loadedContextLength: undefined }
      ])
      expect(models[2]).not.toHaveProperty("loadedContextLength")
      expect(engine.findLlmContextMeasurement).toHaveBeenCalledExactlyOnceWith(
        "a/model",
        []
      )
    })

    it("leaves the context length out of a loaded model whose instances were gone when it was measured", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "a/model" })
      ])
      engine.listLoadedLlmModelInstances.mockResolvedValue([
        createLoadedInstance("a/model")
      ])
      engine.findLlmContextMeasurement.mockResolvedValue(undefined)

      const models = await service.listLlmModels()

      expect(models).toEqual([
        { ...createDownloadedLlmModel({ modelKey: "a/model" }), loaded: true }
      ])
      expect(models[0]).not.toHaveProperty("loadedContextLength")
    })

    it("measures loaded models one at a time, so a runtime that refuses overlapping operations reports each model's length and is idle afterward", async () => {
      fakeLmStudio.reset()
      fakeLmStudio.inventory = {
        downloadedModels: [
          createLmStudioLlmRecord({ modelKey: "a/model" }),
          createLmStudioLlmRecord({ modelKey: "b/model" })
        ],
        loadedModels: [
          { modelKey: "a/model", identifier: "a/model" },
          { modelKey: "b/model", identifier: "b/model" }
        ]
      }
      const contextLengths = new Map([
        ["a/model", 4096],
        ["b/model", 16_384]
      ])
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        getContextLength: async (identifier) =>
          contextLengths.get(identifier) ?? 0
      }
      const runtime = await LmStudioRuntime.create(
        "ws://127.0.0.1:1234",
        DISCARDING_SDK_LOGGER
      )
      onTestFinished(async () => {
        await runtime[Symbol.asyncDispose]()
      })
      const { queue } = createAdmittingQueue(runtime)
      const service = new LlmService({
        llmEngineOperationQueue: queue,
        lysLlmInstanceStore: new InMemoryLysLlmInstanceStore()
      })

      const models = await service.listLlmModels()

      expect(
        models.map(({ modelKey, loadedContextLength }) => ({
          modelKey,
          loadedContextLength
        }))
      ).toEqual([
        { modelKey: "a/model", loadedContextLength: 4096 },
        { modelKey: "b/model", loadedContextLength: 16_384 }
      ])
      await expect(runtime.getRuntimeAvailability()).resolves.toBe("available")
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
      ["loaded", "listLoadedLlmModelInstances"],
      ["context length", "findLlmContextMeasurement"]
    ] as const)(
      "propagates a failed %s inventory query",
      async (_label, failingQuery) => {
        const { service, engine } = createServiceWithEngine()
        engine.listDownloadedLlmModels.mockResolvedValue([
          createDownloadedLlmModel({ modelKey: "a/model" })
        ])
        engine.listLoadedLlmModelInstances.mockResolvedValue([
          createLoadedInstance("a/model")
        ])
        engine.findLlmContextMeasurement.mockResolvedValue({
          contextLength: 4096,
          textTokenCounts: []
        })
        const failure = new Error("The LLM runtime could not list models.")
        engine[failingQuery].mockRejectedValue(failure)

        await expect(service.listLlmModels()).rejects.toBe(failure)
      }
    )
  })

  describe("listDownloadedLlmModels", () => {
    it("returns the engine's downloaded models through the queue without listing or measuring loaded instances", async () => {
      const { service, engine, requests } = createServiceWithEngine()
      const downloadedModels = Object.freeze([
        createDownloadedLlmModel({ modelKey: "b/model" }),
        createDownloadedLlmModel({ modelKey: "a/model" })
      ])
      engine.listDownloadedLlmModels.mockResolvedValue(downloadedModels)

      await expect(service.listDownloadedLlmModels()).resolves.toBe(
        downloadedModels
      )
      expect(requests).toHaveBeenCalledOnce()
      expect(engine.listLoadedLlmModelInstances).not.toHaveBeenCalled()
      expect(engine.findLlmContextMeasurement).not.toHaveBeenCalled()
    })

    it("propagates a failed query", async () => {
      const { service, engine } = createServiceWithEngine()
      const failure = new Error(
        "The LLM runtime could not list downloaded models."
      )
      engine.listDownloadedLlmModels.mockRejectedValue(failure)

      await expect(service.listDownloadedLlmModels()).rejects.toBe(failure)
    })
  })

  describe("loadLlmModel", () => {
    it("loads the selection with the given settings under a new Lys identifier and returns the canonical model's metadata as loaded", async () => {
      const { service, engine } = createServiceWithEngine()
      const loadConfiguration = Object.freeze({
        contextLength: 16_384,
        flashAttention: false
      })
      engine.listLoadedLlmModelInstances.mockResolvedValue([])
      engine.loadLlmModel.mockResolvedValue(
        Object.freeze({
          modelKey: "qwen/qwen3-8b",
          modelIdentifier: "qwen3@lys-7f3c9a"
        })
      )
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "other/model" }),
        createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" })
      ])

      const model = await service.loadLlmModel("qwen3", loadConfiguration)

      expect(engine.loadLlmModel).toHaveBeenCalledExactlyOnceWith(
        "qwen3",
        loadConfiguration,
        "qwen3@lys-7f3c9a"
      )
      expect(model).toEqual({
        ...createDownloadedLlmModel({ modelKey: "qwen/qwen3-8b" }),
        loaded: true
      })
    })

    it("saves the new identifier before the engine loads", async () => {
      const { service, engine, lysLlmInstanceStore } = createServiceWithEngine()
      engine.listLoadedLlmModelInstances.mockResolvedValue([])
      const recordsDuringLoad: unknown[] = []
      engine.loadLlmModel.mockImplementation(
        async (_selection, _configuration, instanceIdentifier) => {
          recordsDuringLoad.push(
            await lysLlmInstanceStore.readLysLlmInstanceIdentifiers()
          )
          return Object.freeze({
            modelKey: "a/model",
            modelIdentifier: instanceIdentifier
          })
        }
      )
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "a/model" })
      ])

      await service.loadLlmModel("a/model", {})

      expect(recordsDuringLoad).toEqual([
        {
          status: "read",
          instanceIdentifiers: new Set(["a/model@lys-7f3c9a"])
        }
      ])
    })

    it("keeps the saved identifiers whose instances are still loaded and drops the others", async () => {
      const lysLlmInstanceStore = createSavedRecord(
        "a/model@lys-000001",
        "b/model@lys-000002"
      )
      const { service, engine } = createServiceWithEngine({
        lysLlmInstanceStore
      })
      engine.listLoadedLlmModelInstances.mockResolvedValue([
        Object.freeze({
          modelKey: "a/model",
          modelIdentifier: "a/model@lys-000001"
        }),
        createLoadedInstance("b/model")
      ])
      engine.loadLlmModel.mockResolvedValue(
        Object.freeze({
          modelKey: "c/model",
          modelIdentifier: "c/model@lys-7f3c9a"
        })
      )
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "c/model" })
      ])

      await service.loadLlmModel("c/model", {})

      expect(lysLlmInstanceStore.listSavedIdentifierSets()).toEqual([
        new Set(["a/model@lys-000001", "c/model@lys-7f3c9a"])
      ])
    })

    it("refuses without saving or loading when the record cannot be read", async () => {
      const lysLlmInstanceStore = new InMemoryLysLlmInstanceStore({
        status: "unreadable",
        message: "The loaded models file is not JSON."
      })
      const { service, engine } = createServiceWithEngine({
        lysLlmInstanceStore
      })
      engine.listLoadedLlmModelInstances.mockResolvedValue([])

      await expect(service.loadLlmModel("a/model", {})).rejects.toThrow(
        "The loaded models file is not JSON. No model was loaded, so the record is left as it is."
      )
      expect(engine.loadLlmModel).not.toHaveBeenCalled()
      expect(lysLlmInstanceStore.listSavedIdentifierSets()).toEqual([])
    })

    it("refuses without loading when the new identifier cannot be saved", async () => {
      const { service, engine, lysLlmInstanceStore } = createServiceWithEngine()
      const saveFailure = new Error("disk full")
      lysLlmInstanceStore.failSaves(saveFailure)
      engine.listLoadedLlmModelInstances.mockResolvedValue([])

      await expect(service.loadLlmModel("a/model", {})).rejects.toBe(
        saveFailure
      )
      expect(engine.loadLlmModel).not.toHaveBeenCalled()
    })

    it("propagates a failed loaded-instance query without saving or loading", async () => {
      const { service, engine, lysLlmInstanceStore } = createServiceWithEngine()
      const failure = new Error(
        "The LLM runtime could not list loaded model instances."
      )
      engine.listLoadedLlmModelInstances.mockRejectedValue(failure)

      await expect(service.loadLlmModel("a/model", {})).rejects.toBe(failure)
      expect(engine.loadLlmModel).not.toHaveBeenCalled()
      expect(lysLlmInstanceStore.listSavedIdentifierSets()).toEqual([])
    })

    it("keeps the identifier of a failed load saved until a later load finds its instance gone", async () => {
      const suffixes = ["000001", "000002"]
      const { service, engine, lysLlmInstanceStore } = createServiceWithEngine({
        createLysInstanceSuffix: () => suffixes.shift() ?? "ffffff"
      })
      engine.listLoadedLlmModelInstances.mockResolvedValue([])
      const failure = new Error("The LLM runtime could not load the model.")
      engine.loadLlmModel.mockRejectedValueOnce(failure).mockResolvedValueOnce(
        Object.freeze({
          modelKey: "a/model",
          modelIdentifier: "a/model@lys-000002"
        })
      )
      engine.listDownloadedLlmModels.mockResolvedValue([
        createDownloadedLlmModel({ modelKey: "a/model" })
      ])

      await expect(service.loadLlmModel("a/model", {})).rejects.toBe(failure)
      await service.loadLlmModel("a/model", {})

      expect(lysLlmInstanceStore.listSavedIdentifierSets()).toEqual([
        new Set(["a/model@lys-000001"]),
        new Set(["a/model@lys-000002"])
      ])
    })

    it("builds the random part from six lowercase hex digits by default", async () => {
      const engine = createFakeLlmRuntime()
      const { queue } = createAdmittingQueue(engine)
      const service = new LlmService({
        llmEngineOperationQueue: queue,
        lysLlmInstanceStore: new InMemoryLysLlmInstanceStore()
      })
      engine.listLoadedLlmModelInstances.mockResolvedValue([])
      engine.loadLlmModel.mockRejectedValue(new Error("stop after the call"))

      await expect(service.loadLlmModel("a/model", {})).rejects.toThrow()

      expect(engine.loadLlmModel.mock.calls[0]?.[2]).toMatch(
        /^a\/model@lys-[0-9a-f]{6}$/
      )
    })

    it("rejects when the loaded model is absent from the downloaded inventory", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.listLoadedLlmModelInstances.mockResolvedValue([])
      engine.loadLlmModel.mockResolvedValue(
        Object.freeze({ modelKey: "qwen/qwen3-8b", modelIdentifier: "id" })
      )
      engine.listDownloadedLlmModels.mockResolvedValue([])

      await expect(service.loadLlmModel("qwen/qwen3-8b", {})).rejects.toThrow(
        'Loaded model "qwen/qwen3-8b" was not found in the downloaded LLM inventory'
      )
    })

    it("propagates a load failure without querying inventory", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.listLoadedLlmModelInstances.mockResolvedValue([])
      const failure = new Error("The LLM runtime could not load the model.")
      engine.loadLlmModel.mockRejectedValue(failure)

      await expect(service.loadLlmModel("qwen/qwen3-8b", {})).rejects.toBe(
        failure
      )
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
        lysLlmInstanceStore: new InMemoryLysLlmInstanceStore(),
        readMonotonicTimeMs: () => nowMs
      })

      const health = service.getLlmModelHealth("a/model")
      await waitForMicrotasks()
      nowMs = 500
      admission.resolve()
      await waitForMicrotasks()
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

  describe("findLlmContextMeasurement", () => {
    it("measures the texts through the queued engine and returns its measurement", async () => {
      const { service, engine, requests } = createServiceWithEngine()
      const measurement = Object.freeze({
        contextLength: 8192,
        textTokenCounts: Object.freeze([4, 1])
      })
      engine.findLlmContextMeasurement.mockResolvedValue(measurement)

      await expect(
        service.findLlmContextMeasurement("qwen/qwen3-8b", [
          "You are Lys.",
          "Hello"
        ])
      ).resolves.toBe(measurement)
      expect(engine.findLlmContextMeasurement).toHaveBeenCalledExactlyOnceWith(
        "qwen/qwen3-8b",
        ["You are Lys.", "Hello"]
      )
      expect(requests).toHaveBeenCalledOnce()
    })

    it("resolves to undefined when the engine finds no loaded instance", async () => {
      const { service, engine } = createServiceWithEngine()
      engine.findLlmContextMeasurement.mockResolvedValue(undefined)

      await expect(
        service.findLlmContextMeasurement("qwen/qwen3-8b", ["Hello"])
      ).resolves.toBeUndefined()
    })
  })

  describe("queue rejection", () => {
    it.each([
      "listLlmModels",
      "listDownloadedLlmModels",
      "loadLlmModel",
      "getLlmModelHealth",
      "stopLlmModelsByKey",
      "findLlmContextMeasurement"
    ] as const)(
      "propagates the queue's rejection from %s without engine work",
      async (operationName) => {
        const { service, engine, requests } = createServiceWithEngine()
        const refusal = new Error("The LLM runtime is closed.")
        requests.mockRejectedValue(refusal)

        await expect(
          sendLlmServiceRequest(service, operationName)
        ).rejects.toBe(refusal)
        expect(requests).toHaveBeenCalledOnce()
        expect(engine.listDownloadedLlmModels).not.toHaveBeenCalled()
        expect(engine.listLoadedLlmModelInstances).not.toHaveBeenCalled()
        expect(engine.loadLlmModel).not.toHaveBeenCalled()
        expect(engine.stopLoadedLlmModelInstance).not.toHaveBeenCalled()
        expect(engine.findLlmContextMeasurement).not.toHaveBeenCalled()
      }
    )
  })
})
