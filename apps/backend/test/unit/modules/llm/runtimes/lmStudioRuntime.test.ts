import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import LmStudioRuntime from "../../../../../src/modules/llm/runtimes/lmStudioRuntime"
import { createLmStudioLlmRecord } from "../../../support/llmFixtures"
import {
  fakeLmStudio,
  type FakeLmStudioOperations
} from "../../../support/lmStudioSdkFake"
import { waitForMicrotasks } from "../../../support/microtasks"

vi.mock("@lmstudio/sdk", () => import("../../../support/lmStudioSdkFake"))

/** Endpoint passed to every runtime in these cases. */
const LM_STUDIO_URL = "ws://127.0.0.1:1234"

/**
 * Acquires a runtime owned by the current test.
 *
 * @returns The ready runtime, disposed when the test finishes unless a case
 * already began disposal.
 */
async function createOwnedRuntime(): Promise<LmStudioRuntime> {
  const runtime = await LmStudioRuntime.create(LM_STUDIO_URL)
  onTestFinished(async () => {
    await runtime[Symbol.asyncDispose]().catch(() => undefined)
  })
  return runtime
}

/**
 * Gets the rejection of an operation expected to fail.
 *
 * @param operation - Pending operation.
 * @returns The rejection value.
 * @throws If the operation resolves.
 */
async function getRejection(operation: Promise<unknown>): Promise<unknown> {
  return await operation.then(
    () => {
      throw new Error("Expected the operation to reject")
    },
    (error: unknown) => error
  )
}

describe("LmStudioRuntime", () => {
  beforeEach(() => {
    fakeLmStudio.reset()
  })

  describe("create", () => {
    it("connects to the endpoint and returns a ready runtime after the readiness query", async () => {
      const constructClient = vi.fn<FakeLmStudioOperations["constructClient"]>()
      const disposeClient = vi.fn(async () => undefined)
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        constructClient,
        disposeClient
      }

      const runtime = await createOwnedRuntime()

      expect(runtime.lifecycleStatus).toBe("ready")
      expect(constructClient).toHaveBeenCalledExactlyOnceWith({
        baseUrl: LM_STUDIO_URL
      })
      expect(disposeClient).not.toHaveBeenCalled()
    })

    it("releases the client and reports unavailability when the readiness query fails", async () => {
      const queryFailure = new Error("connect ECONNREFUSED")
      const disposeClient = vi.fn(async () => undefined)
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        getLMStudioVersion: async () => {
          throw queryFailure
        },
        disposeClient
      }

      const failure = await getRejection(LmStudioRuntime.create(LM_STUDIO_URL))

      expect(failure).toMatchObject({
        message: "The LLM runtime is unavailable.",
        cause: queryFailure
      })
      expect(disposeClient).toHaveBeenCalledOnce()
    })

    it("keeps both failures when releasing the client also fails", async () => {
      const queryFailure = new Error("connect ECONNREFUSED")
      const releaseFailure = new Error("socket already destroyed")
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        getLMStudioVersion: async () => {
          throw queryFailure
        },
        disposeClient: async () => {
          throw releaseFailure
        }
      }

      const failure = await getRejection(LmStudioRuntime.create(LM_STUDIO_URL))

      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure).toMatchObject({
        errors: [
          expect.objectContaining({
            message: "The LLM runtime is unavailable.",
            cause: queryFailure
          }),
          releaseFailure
        ]
      })
    })

    it("propagates a client construction failure without a client to release", async () => {
      const constructionFailure = new Error("Invalid baseUrl")
      const disposeClient = vi.fn(async () => undefined)
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        constructClient: () => {
          throw constructionFailure
        },
        disposeClient
      }

      await expect(LmStudioRuntime.create("not a url")).rejects.toBe(
        constructionFailure
      )
      expect(disposeClient).not.toHaveBeenCalled()
    })
  })

  describe("getRuntimeAvailability", () => {
    it("reports available when the readiness query succeeds", async () => {
      const runtime = await createOwnedRuntime()

      await expect(runtime.getRuntimeAvailability()).resolves.toBe("available")
    })

    it("reports unavailable when the readiness query fails", async () => {
      const runtime = await createOwnedRuntime()
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        getLMStudioVersion: async () => {
          throw new Error("socket closed")
        }
      }

      await expect(runtime.getRuntimeAvailability()).resolves.toBe(
        "unavailable"
      )
      expect(runtime.lifecycleStatus).toBe("ready")
    })
  })

  describe("listDownloadedLlmModels", () => {
    it("returns frozen normalized metadata for downloaded LLMs", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [
          createLmStudioLlmRecord({ modelKey: "qwen/qwen3-8b" })
        ],
        loadedModels: []
      }
      const runtime = await createOwnedRuntime()

      const models = await runtime.listDownloadedLlmModels()

      expect(models).toEqual([
        {
          modelKey: "qwen/qwen3-8b",
          format: "gguf",
          displayName: "Display qwen/qwen3-8b",
          path: "qwen/qwen3-8b/model.gguf",
          sizeBytes: 4096,
          paramsString: "7B",
          architecture: "llama",
          quantization: { name: "Q4_K_M", bits: 4 },
          vision: false,
          trainedForToolUse: false,
          maxContextLength: 8192
        }
      ])
      expect(Object.isFrozen(models)).toBe(true)
    })

    it("translates a failed query and keeps the SDK failure as its cause", async () => {
      const runtime = await createOwnedRuntime()
      const sdkFailure = new Error("socket closed")
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        listDownloadedModels: async () => {
          throw sdkFailure
        }
      }

      await expect(runtime.listDownloadedLlmModels()).rejects.toMatchObject({
        message: "The LLM runtime could not list downloaded models.",
        cause: sdkFailure
      })
      expect(runtime.lifecycleStatus).toBe("ready")
    })

    it("rejects malformed vendor metadata", async () => {
      const runtime = await createOwnedRuntime()
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        listDownloadedModels: async () => [{ type: "llm", modelKey: "" }]
      }

      await expect(runtime.listDownloadedLlmModels()).rejects.toThrow(
        "The LLM runtime returned invalid model metadata."
      )
    })
  })

  describe("listLoadedLlmModelInstances", () => {
    it("returns frozen identities of the loaded handles", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [],
        loadedModels: [
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b:2" }
        ]
      }
      const runtime = await createOwnedRuntime()

      const instances = await runtime.listLoadedLlmModelInstances()

      expect(instances).toEqual([
        { modelKey: "qwen/qwen3-8b", modelIdentifier: "qwen/qwen3-8b:2" }
      ])
      expect(Object.isFrozen(instances)).toBe(true)
    })

    it("translates a failed query and keeps the SDK failure as its cause", async () => {
      const runtime = await createOwnedRuntime()
      const sdkFailure = new Error("socket closed")
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        listLoaded: async () => {
          throw sdkFailure
        }
      }

      await expect(runtime.listLoadedLlmModelInstances()).rejects.toMatchObject(
        {
          message: "The LLM runtime could not list loaded model instances.",
          cause: sdkFailure
        }
      )
    })

    it("rejects a malformed loaded handle", async () => {
      const runtime = await createOwnedRuntime()
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        listLoaded: async () => [{ modelKey: "qwen" }]
      }

      await expect(runtime.listLoadedLlmModelInstances()).rejects.toThrow(
        "The LLM runtime returned an invalid model instance."
      )
    })
  })

  describe("loadLlmModel", () => {
    it("loads the selection and returns the loaded instance identity", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [
          createLmStudioLlmRecord({ modelKey: "qwen/qwen3-8b" })
        ],
        loadedModels: []
      }
      const runtime = await createOwnedRuntime()

      await expect(runtime.loadLlmModel("qwen/qwen3-8b", {})).resolves.toEqual({
        modelKey: "qwen/qwen3-8b",
        modelIdentifier: "qwen/qwen3-8b"
      })
      expect(fakeLmStudio.inventory.loadedModels).toEqual([
        { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" }
      ])
    })

    it("sends every set load setting to the SDK as its load config", async () => {
      const runtime = await createOwnedRuntime()
      const load = vi.fn(fakeLmStudio.operations.load)
      load.mockResolvedValue({ modelKey: "qwen", identifier: "qwen" })
      fakeLmStudio.operations = { ...fakeLmStudio.operations, load }

      await runtime.loadLlmModel("qwen", {
        contextLength: 16_384,
        evalBatchSize: 1024,
        flashAttention: false,
        offloadKVCacheToGpu: true,
        numExperts: 4
      })

      expect(load).toHaveBeenCalledExactlyOnceWith("qwen", {
        config: {
          contextLength: 16_384,
          evalBatchSize: 1024,
          flashAttention: false,
          offloadKVCacheToGpu: true,
          numExperts: 4
        }
      })
    })

    it("sends an empty load config when no setting is set", async () => {
      const runtime = await createOwnedRuntime()
      const load = vi.fn(fakeLmStudio.operations.load)
      load.mockResolvedValue({ modelKey: "qwen", identifier: "qwen" })
      fakeLmStudio.operations = { ...fakeLmStudio.operations, load }

      await runtime.loadLlmModel("qwen", {})

      expect(load).toHaveBeenCalledExactlyOnceWith("qwen", { config: {} })
    })

    it("leaves a setting that is not set out of the load config", async () => {
      const runtime = await createOwnedRuntime()
      const load = vi.fn(fakeLmStudio.operations.load)
      load.mockResolvedValue({ modelKey: "qwen", identifier: "qwen" })
      fakeLmStudio.operations = { ...fakeLmStudio.operations, load }

      await runtime.loadLlmModel("qwen", { contextLength: 8192 })

      const [, options] = load.mock.calls[0] ?? []
      expect(Object.keys(options?.config ?? {})).toEqual(["contextLength"])
    })

    it.each([
      {
        absentSetting: "contextLength",
        loadConfiguration: {
          evalBatchSize: 1024,
          flashAttention: false,
          offloadKVCacheToGpu: true,
          numExperts: 4
        }
      },
      {
        absentSetting: "evalBatchSize",
        loadConfiguration: {
          contextLength: 16_384,
          flashAttention: false,
          offloadKVCacheToGpu: true,
          numExperts: 4
        }
      },
      {
        absentSetting: "flashAttention",
        loadConfiguration: {
          contextLength: 16_384,
          evalBatchSize: 1024,
          offloadKVCacheToGpu: true,
          numExperts: 4
        }
      },
      {
        absentSetting: "offloadKVCacheToGpu",
        loadConfiguration: {
          contextLength: 16_384,
          evalBatchSize: 1024,
          flashAttention: false,
          numExperts: 4
        }
      },
      {
        absentSetting: "numExperts",
        loadConfiguration: {
          contextLength: 16_384,
          evalBatchSize: 1024,
          flashAttention: false,
          offloadKVCacheToGpu: true
        }
      }
    ])(
      "sends the other four settings and no $absentSetting when only that one is not set",
      async ({ absentSetting, loadConfiguration }) => {
        const runtime = await createOwnedRuntime()
        const load = vi.fn(fakeLmStudio.operations.load)
        load.mockResolvedValue({ modelKey: "qwen", identifier: "qwen" })
        fakeLmStudio.operations = { ...fakeLmStudio.operations, load }

        await runtime.loadLlmModel("qwen", loadConfiguration)

        const [, options] = load.mock.calls[0] ?? []
        expect(options?.config).toEqual(loadConfiguration)
        expect(Object.keys(options?.config ?? {})).not.toContain(absentSetting)
      }
    )

    it("translates a failed load and keeps the SDK failure as its cause", async () => {
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.loadLlmModel("missing/model", {})
      ).rejects.toMatchObject({
        message: "The LLM runtime could not load the model.",
        cause: expect.objectContaining({
          message: 'Model "missing/model" is not downloaded.'
        })
      })
      expect(runtime.lifecycleStatus).toBe("ready")
    })

    it("rejects a loaded handle without a valid identity", async () => {
      const runtime = await createOwnedRuntime()
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        load: async () => ({ modelKey: "qwen" })
      }

      await expect(runtime.loadLlmModel("qwen", {})).rejects.toThrow(
        "The LLM runtime returned an invalid model instance."
      )
    })
  })

  describe("stopLoadedLlmModelInstance", () => {
    it("unloads the addressed instance", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [],
        loadedModels: [
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" },
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b:2" }
        ]
      }
      const runtime = await createOwnedRuntime()

      await runtime.stopLoadedLlmModelInstance("qwen/qwen3-8b:2")

      expect(fakeLmStudio.inventory.loadedModels).toEqual([
        { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" }
      ])
    })

    it("translates a failed unload and keeps the SDK failure as its cause", async () => {
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.stopLoadedLlmModelInstance("missing")
      ).rejects.toMatchObject({
        message: "The LLM runtime could not stop the model instance.",
        cause: expect.objectContaining({
          message: 'No loaded instance "missing".'
        })
      })
      expect(runtime.lifecycleStatus).toBe("ready")
    })
  })

  describe("operation admission", () => {
    it("is active while an operation runs and ready after it settles", async () => {
      const runtime = await createOwnedRuntime()
      const listing = Promise.withResolvers<readonly unknown[]>()
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        listLoaded: () => listing.promise
      }

      const operation = runtime.listLoadedLlmModelInstances()
      expect(runtime.lifecycleStatus).toBe("active")
      listing.resolve([])
      await operation

      expect(runtime.lifecycleStatus).toBe("ready")
    })

    it("refuses an overlapping operation before reaching the SDK", async () => {
      const runtime = await createOwnedRuntime()
      const listing = Promise.withResolvers<readonly unknown[]>()
      const load = vi.fn(fakeLmStudio.operations.load)
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        listLoaded: () => listing.promise,
        load
      }
      const active = runtime.listLoadedLlmModelInstances()

      await expect(runtime.loadLlmModel("qwen", {})).rejects.toThrow(
        "The LLM runtime already has an active operation."
      )
      await expect(runtime.getRuntimeAvailability()).rejects.toThrow(
        "The LLM runtime already has an active operation."
      )

      expect(load).not.toHaveBeenCalled()
      listing.resolve([])
      await active
    })
  })

  describe("disposal", () => {
    it("releases the client once and ends closed", async () => {
      const disposeClient = vi.fn(async () => undefined)
      fakeLmStudio.operations = { ...fakeLmStudio.operations, disposeClient }
      const runtime = await createOwnedRuntime()

      await runtime[Symbol.asyncDispose]()

      expect(runtime.lifecycleStatus).toBe("closed")
      expect(disposeClient).toHaveBeenCalledOnce()
    })

    it("waits for the active operation before releasing the client", async () => {
      const listing = Promise.withResolvers<readonly unknown[]>()
      const disposeClient = vi.fn(async () => undefined)
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        listLoaded: () => listing.promise,
        disposeClient
      }
      const runtime = await createOwnedRuntime()
      const active = runtime.listLoadedLlmModelInstances()

      const disposal = runtime[Symbol.asyncDispose]()
      await waitForMicrotasks()
      expect(runtime.lifecycleStatus).toBe("closing")
      expect(disposeClient).not.toHaveBeenCalled()

      listing.resolve([])
      await expect(active).resolves.toEqual([])
      await disposal
      expect(runtime.lifecycleStatus).toBe("closed")
      expect(disposeClient).toHaveBeenCalledOnce()
    })

    it("refuses operations once cleanup begins", async () => {
      const runtime = await createOwnedRuntime()

      const disposal = runtime[Symbol.asyncDispose]()

      await expect(runtime.listDownloadedLlmModels()).rejects.toThrow(
        "The LLM runtime is closed."
      )
      await disposal
      await expect(runtime.getRuntimeAvailability()).rejects.toThrow(
        "The LLM runtime is closed."
      )
    })

    it("shares one release across concurrent and repeated calls", async () => {
      const disposeClient = vi.fn(async () => undefined)
      fakeLmStudio.operations = { ...fakeLmStudio.operations, disposeClient }
      const runtime = await createOwnedRuntime()

      await Promise.all([
        runtime[Symbol.asyncDispose](),
        runtime[Symbol.asyncDispose]()
      ])
      await runtime[Symbol.asyncDispose]()

      expect(disposeClient).toHaveBeenCalledOnce()
    })

    it("reports a failed release, stays closed, and never retries it", async () => {
      const runtime = await createOwnedRuntime()
      const releaseFailure = new Error("socket already destroyed")
      const disposeClient = vi.fn(async () => {
        throw releaseFailure
      })
      fakeLmStudio.operations = { ...fakeLmStudio.operations, disposeClient }

      const firstFailure = await getRejection(runtime[Symbol.asyncDispose]())
      const repeatedFailure = await getRejection(runtime[Symbol.asyncDispose]())

      expect(firstFailure).toMatchObject({
        message: "The LLM runtime could not release its resources.",
        cause: releaseFailure
      })
      expect(repeatedFailure).toBe(firstFailure)
      expect(runtime.lifecycleStatus).toBe("closed")
      expect(disposeClient).toHaveBeenCalledOnce()
    })
  })
})
