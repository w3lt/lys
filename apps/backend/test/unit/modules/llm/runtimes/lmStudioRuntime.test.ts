import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import LmStudioRuntime from "../../../../../src/modules/llm/runtimes/lmStudioRuntime"
import { createLmStudioLlmRecord } from "../../../support/llmFixtures"
import {
  DISCARDING_SDK_LOGGER,
  FAKE_LOADED_CONTEXT_LENGTH,
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
  const runtime = await LmStudioRuntime.create(
    LM_STUDIO_URL,
    DISCARDING_SDK_LOGGER
  )
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

/**
 * Checks that a runtime is ready: it admits a new operation.
 *
 * @param runtime - Runtime with no operation running and no disposal begun.
 * @remarks The availability query resolves whatever LM Studio answers and
 * rejects only when the runtime refuses it, so resolving shows admission.
 */
async function expectOperationAdmitted(
  runtime: LmStudioRuntime
): Promise<void> {
  await expect(runtime.getRuntimeAvailability()).resolves.toMatch(
    /^(available|unavailable)$/
  )
}

/**
 * Checks that a runtime refuses a new operation because its disposal began,
 * whether cleanup is still running or has settled.
 *
 * @param runtime - Runtime whose disposal began.
 */
async function expectOperationRefusedAsClosed(
  runtime: LmStudioRuntime
): Promise<void> {
  await expect(runtime.getRuntimeAvailability()).rejects.toThrow(
    "The LLM runtime is closed."
  )
}

describe("LmStudioRuntime", () => {
  beforeEach(() => {
    fakeLmStudio.reset()
  })

  describe("create", () => {
    it("connects to the endpoint with the given SDK logger and returns a ready runtime after the readiness query", async () => {
      const constructClient = vi.fn<FakeLmStudioOperations["constructClient"]>()
      const disposeClient = vi.fn(async () => undefined)
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        constructClient,
        disposeClient
      }

      const runtime = await createOwnedRuntime()

      await expectOperationAdmitted(runtime)
      expect(constructClient).toHaveBeenCalledExactlyOnceWith({
        baseUrl: LM_STUDIO_URL,
        logger: DISCARDING_SDK_LOGGER
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

      const failure = await getRejection(
        LmStudioRuntime.create(LM_STUDIO_URL, DISCARDING_SDK_LOGGER)
      )

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

      const failure = await getRejection(
        LmStudioRuntime.create(LM_STUDIO_URL, DISCARDING_SDK_LOGGER)
      )

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

      await expect(
        LmStudioRuntime.create("not a url", DISCARDING_SDK_LOGGER)
      ).rejects.toBe(constructionFailure)
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
      await expectOperationAdmitted(runtime)
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
      await expectOperationAdmitted(runtime)
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
    it("loads the selection under the given identifier and returns the loaded instance identity", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [
          createLmStudioLlmRecord({ modelKey: "qwen/qwen3-8b" })
        ],
        loadedModels: []
      }
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.loadLlmModel("qwen/qwen3-8b", {}, "qwen/qwen3-8b@lys-7f3c9a")
      ).resolves.toEqual({
        modelKey: "qwen/qwen3-8b",
        modelIdentifier: "qwen/qwen3-8b@lys-7f3c9a"
      })
      expect(fakeLmStudio.inventory.loadedModels).toEqual([
        { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b@lys-7f3c9a" }
      ])
    })

    it("translates the refusal of an identifier already in use", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [
          createLmStudioLlmRecord({ modelKey: "qwen/qwen3-8b" })
        ],
        loadedModels: [
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b@lys-7f3c9a" }
        ]
      }
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.loadLlmModel("qwen/qwen3-8b", {}, "qwen/qwen3-8b@lys-7f3c9a")
      ).rejects.toMatchObject({
        message: "The LLM runtime could not load the model.",
        cause: expect.objectContaining({
          message: 'Identifier "qwen/qwen3-8b@lys-7f3c9a" is already in use.'
        })
      })
      expect(fakeLmStudio.inventory.loadedModels).toHaveLength(1)
    })

    it("sends every set load setting to the SDK as its load config", async () => {
      const runtime = await createOwnedRuntime()
      const load = vi.fn(fakeLmStudio.operations.load)
      load.mockResolvedValue({ modelKey: "qwen", identifier: "qwen" })
      fakeLmStudio.operations = { ...fakeLmStudio.operations, load }

      await runtime.loadLlmModel(
        "qwen",
        {
          contextLength: 16_384,
          evalBatchSize: 1024,
          flashAttention: false,
          offloadKVCacheToGpu: true,
          numExperts: 4
        },
        "qwen@lys-000001"
      )

      expect(load).toHaveBeenCalledExactlyOnceWith("qwen", {
        identifier: "qwen@lys-000001",
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

      await runtime.loadLlmModel("qwen", {}, "qwen@lys-000001")

      expect(load).toHaveBeenCalledExactlyOnceWith("qwen", {
        identifier: "qwen@lys-000001",
        config: {}
      })
    })

    it("leaves a setting that is not set out of the load config", async () => {
      const runtime = await createOwnedRuntime()
      const load = vi.fn(fakeLmStudio.operations.load)
      load.mockResolvedValue({ modelKey: "qwen", identifier: "qwen" })
      fakeLmStudio.operations = { ...fakeLmStudio.operations, load }

      await runtime.loadLlmModel(
        "qwen",
        { contextLength: 8192 },
        "qwen@lys-000001"
      )

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

        await runtime.loadLlmModel("qwen", loadConfiguration, "qwen@lys-000001")

        const [, options] = load.mock.calls[0] ?? []
        expect(options?.config).toEqual(loadConfiguration)
        expect(Object.keys(options?.config ?? {})).not.toContain(absentSetting)
      }
    )

    it("translates a failed load and keeps the SDK failure as its cause", async () => {
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.loadLlmModel("missing/model", {}, "missing/model@lys-000001")
      ).rejects.toMatchObject({
        message: "The LLM runtime could not load the model.",
        cause: expect.objectContaining({
          message: 'Model "missing/model" is not downloaded.'
        })
      })
      await expectOperationAdmitted(runtime)
    })

    it("rejects a loaded handle without a valid identity", async () => {
      const runtime = await createOwnedRuntime()
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        load: async () => ({ modelKey: "qwen" })
      }

      await expect(
        runtime.loadLlmModel("qwen", {}, "qwen@lys-000001")
      ).rejects.toThrow("The LLM runtime returned an invalid model instance.")
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
      await expectOperationAdmitted(runtime)
    })
  })

  describe("findLlmContextMeasurement", () => {
    it("counts each text with the model's tokenizer and reports the context length it is loaded with", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [],
        loadedModels: [
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" }
        ]
      }
      const countTokens = vi.fn(fakeLmStudio.operations.countTokens)
      fakeLmStudio.operations = { ...fakeLmStudio.operations, countTokens }
      const runtime = await createOwnedRuntime()

      const measurement = await runtime.findLlmContextMeasurement(
        "qwen/qwen3-8b",
        ["You are Lys.", "", "Hello"]
      )

      expect(measurement).toEqual({
        contextLength: FAKE_LOADED_CONTEXT_LENGTH,
        textTokenCounts: [12, 0, 5]
      })
      expect(countTokens.mock.calls).toEqual([
        ["qwen/qwen3-8b", "You are Lys."],
        ["qwen/qwen3-8b", ""],
        ["qwen/qwen3-8b", "Hello"]
      ])
      expect(Object.isFrozen(measurement)).toBe(true)
      expect(Object.isFrozen(measurement?.textTokenCounts)).toBe(true)
    })

    it("reports the smallest context length among the instances a model key names", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [],
        loadedModels: [
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" },
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b:2" },
          { modelKey: "google/gemma-4-12b", identifier: "google/gemma-4-12b" }
        ]
      }
      const contextLengths = new Map([
        ["qwen/qwen3-8b", 16_384],
        ["qwen/qwen3-8b:2", 8192],
        ["google/gemma-4-12b", 2048]
      ])
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        getContextLength: async (identifier) =>
          contextLengths.get(identifier) ?? 0
      }
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.findLlmContextMeasurement("qwen/qwen3-8b", ["Hi"])
      ).resolves.toEqual({ contextLength: 8192, textTokenCounts: [2] })
    })

    it("measures only the instance an instance identifier names", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [],
        loadedModels: [
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" },
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b:2" }
        ]
      }
      const getContextLength = vi.fn(async (identifier: string) =>
        identifier === "qwen/qwen3-8b:2" ? 32_768 : 4096
      )
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        getContextLength
      }
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.findLlmContextMeasurement("qwen/qwen3-8b:2", [])
      ).resolves.toEqual({ contextLength: 32_768, textTokenCounts: [] })
      expect(getContextLength).toHaveBeenCalledExactlyOnceWith(
        "qwen/qwen3-8b:2"
      )
    })

    it("resolves to undefined without asking a tokenizer when the model is not loaded", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [],
        loadedModels: [
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" }
        ]
      }
      const countTokens = vi.fn<FakeLmStudioOperations["countTokens"]>()
      fakeLmStudio.operations = { ...fakeLmStudio.operations, countTokens }
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.findLlmContextMeasurement("google/gemma-4-12b", ["Hello"])
      ).resolves.toBeUndefined()
      expect(countTokens).not.toHaveBeenCalled()
    })

    it("does not ask the tokenizer when there is no text", async () => {
      fakeLmStudio.inventory = {
        downloadedModels: [],
        loadedModels: [
          { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" }
        ]
      }
      const countTokens = vi.fn<FakeLmStudioOperations["countTokens"]>()
      fakeLmStudio.operations = { ...fakeLmStudio.operations, countTokens }
      const runtime = await createOwnedRuntime()

      await expect(
        runtime.findLlmContextMeasurement("qwen/qwen3-8b", [])
      ).resolves.toEqual({
        contextLength: FAKE_LOADED_CONTEXT_LENGTH,
        textTokenCounts: []
      })
      expect(countTokens).not.toHaveBeenCalled()
    })

    it.each([
      [
        "a failed loaded-instance query",
        {
          listLoaded: async () => {
            throw new Error("socket closed")
          }
        }
      ],
      [
        "a failed context length query",
        {
          getContextLength: async () => {
            throw new Error("socket closed")
          }
        }
      ],
      [
        "a failed tokenizer query",
        {
          countTokens: async () => {
            throw new Error("socket closed")
          }
        }
      ],
      [
        "a context length that is not positive",
        { getContextLength: async () => 0 }
      ],
      [
        "a context length that is not whole",
        { getContextLength: async () => 4096.5 }
      ],
      ["a token count that is not whole", { countTokens: async () => 1.5 }],
      ["a negative token count", { countTokens: async () => -1 }]
    ] satisfies readonly (readonly [
      string,
      Partial<FakeLmStudioOperations>
    ])[])(
      "translates %s and keeps the reason as its cause",
      async (_scenario, operations) => {
        fakeLmStudio.inventory = {
          downloadedModels: [],
          loadedModels: [
            { modelKey: "qwen/qwen3-8b", identifier: "qwen/qwen3-8b" }
          ]
        }
        fakeLmStudio.operations = { ...fakeLmStudio.operations, ...operations }
        const runtime = await createOwnedRuntime()

        const failure = await getRejection(
          runtime.findLlmContextMeasurement("qwen/qwen3-8b", ["Hi", "Lys"])
        )

        expect(failure).toMatchObject({
          message: "The LLM runtime could not measure the context.",
          cause: expect.any(Error)
        })
        await expectOperationAdmitted(runtime)
      }
    )
  })

  describe("operation admission", () => {
    it("admits a new operation once the running one settles", async () => {
      const runtime = await createOwnedRuntime()
      const listing = Promise.withResolvers<readonly unknown[]>()
      fakeLmStudio.operations = {
        ...fakeLmStudio.operations,
        listLoaded: () => listing.promise
      }

      const operation = runtime.listLoadedLlmModelInstances()
      await expect(runtime.getRuntimeAvailability()).rejects.toThrow(
        "The LLM runtime already has an active operation."
      )
      listing.resolve([])
      await operation

      await expectOperationAdmitted(runtime)
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

      await expect(
        runtime.loadLlmModel("qwen", {}, "qwen@lys-000001")
      ).rejects.toThrow("The LLM runtime already has an active operation.")
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

      await expectOperationRefusedAsClosed(runtime)
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
      await expectOperationRefusedAsClosed(runtime)
      expect(disposeClient).not.toHaveBeenCalled()

      listing.resolve([])
      await expect(active).resolves.toEqual([])
      await disposal
      await expectOperationRefusedAsClosed(runtime)
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
      await expectOperationRefusedAsClosed(runtime)
      expect(disposeClient).toHaveBeenCalledOnce()
    })
  })
})
