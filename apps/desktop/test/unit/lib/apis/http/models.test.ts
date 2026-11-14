import {
  createLlmProviderLoadsModelsProblem,
  createLlmRuntimeUnavailableProblem,
  createLlmServiceBusyProblem,
  createLlmUnloadProblem
} from "@lys/protocol"
import {
  modelLoadConfigurationSchema,
  type LlmModelReference
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  getModelHealth,
  isModelRuntimeUnavailableError,
  listModels,
  loadModel,
  unloadModel
} from "@/lib/apis/http/models"
import {
  buildJsonResponse,
  FIXTURE_BACKEND_URL,
  startBackendFake
} from "../../../support/backendFake"
import { buildLlmInfo } from "../../../support/modelFixtures"

/**
 * Load settings a load sends: two of the five settings, so LM Studio decides
 * the three left out. Frozen and validated by the shared schema.
 */
const LOAD_CONFIGURATION = modelLoadConfigurationSchema.parse({
  contextLength: 16384,
  flashAttention: false
})

/**
 * Names one of LM Studio's models.
 *
 * @param modelKey - Key of the model.
 * @returns The reference.
 */
function buildLmStudioModel(modelKey: string): LlmModelReference {
  return { provider: "lmStudio", modelKey }
}

/**
 * Builds a connection the case does not cancel.
 *
 * @returns The connection and its signal, which the request must carry.
 */
function createConnection() {
  return {
    backendUrl: FIXTURE_BACKEND_URL,
    signal: new AbortController().signal
  }
}

/**
 * Lists models through a backend that fails the list request.
 *
 * @param response - Failure response the backend sends.
 * @returns The rejection reason of the list request.
 */
async function getListModelsFailure(response: Response): Promise<unknown> {
  startBackendFake({ "GET /api/v1/llm/lmStudio/list": () => response })
  return await listModels("lmStudio", createConnection()).catch(
    (error: unknown) => error
  )
}

describe("listModels", () => {
  it.each(["lys", "provider"] as const)(
    "returns the listed models and who loads them (%s) after a validated response",
    async (modelLoading) => {
      const models = [
        buildLlmInfo("qwen3-8b", { loaded: true }),
        buildLlmInfo("gemma-3")
      ]
      const backend = startBackendFake({
        "GET /api/v1/llm/lmStudio/list": () =>
          buildJsonResponse(200, { llms: models, modelLoading })
      })
      const connection = createConnection()

      await expect(listModels("lmStudio", connection)).resolves.toEqual({
        llms: models,
        modelLoading
      })
      expect(backend.requests).toHaveLength(1)
      expect(backend.requests[0]?.url).toBe(
        `${FIXTURE_BACKEND_URL}/api/v1/llm/lmStudio/list`
      )
      expect(backend.requests[0]?.signal).toBe(connection.signal)
      expect(backend.requests[0]?.cache).toBe("no-store")
    }
  )

  it.each(["ollama", "ollamaCloud", "groq"] as const)(
    "requests the list of the provider it names (%s)",
    async (provider) => {
      const backend = startBackendFake({
        [`GET /api/v1/llm/${provider}/list`]: () =>
          buildJsonResponse(200, { llms: [], modelLoading: "provider" })
      })

      await expect(listModels(provider, createConnection())).resolves.toEqual({
        llms: [],
        modelLoading: "provider"
      })
      expect(backend.requests[0]?.url).toBe(
        `${FIXTURE_BACKEND_URL}/api/v1/llm/${provider}/list`
      )
    }
  )

  it("rejects a list that does not say who loads the models", async () => {
    startBackendFake({
      "GET /api/v1/llm/lmStudio/list": () =>
        buildJsonResponse(200, { llms: [buildLlmInfo("qwen3-8b")] })
    })

    await expect(listModels("lmStudio", createConnection())).rejects.toThrow(
      "The backend returned an invalid model response."
    )
  })

  it("rejects a list that names a model twice", async () => {
    const model = buildLlmInfo("qwen3-8b")
    startBackendFake({
      "GET /api/v1/llm/lmStudio/list": () =>
        buildJsonResponse(200, { llms: [model, model], modelLoading: "lys" })
    })

    await expect(listModels("lmStudio", createConnection())).rejects.toThrow(
      Error
    )
  })

  it("rejects a list containing an empty model key", async () => {
    startBackendFake({
      "GET /api/v1/llm/lmStudio/list": () =>
        buildJsonResponse(200, {
          llms: [buildLlmInfo("")],
          modelLoading: "lys"
        })
    })

    await expect(listModels("lmStudio", createConnection())).rejects.toThrow(
      Error
    )
  })

  it("rejects a malformed list and keeps the decoding failure as its cause", async () => {
    startBackendFake({
      "GET /api/v1/llm/lmStudio/list": () =>
        buildJsonResponse(200, {
          llms: [{ modelKey: "raw-secret" }],
          modelLoading: "lys"
        })
    })

    const models = listModels("lmStudio", createConnection())

    await expect(models).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
    await expect(models).rejects.not.toThrow("raw-secret")
  })

  it("rejects a success response that is not JSON", async () => {
    startBackendFake({
      "GET /api/v1/llm/lmStudio/list": () =>
        new Response(JSON.stringify({ llms: [], modelLoading: "lys" }), {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        })
    })

    await expect(listModels("lmStudio", createConnection())).rejects.toThrow(
      Error
    )
  })

  it("rejects a success status other than 200", async () => {
    startBackendFake({
      "GET /api/v1/llm/lmStudio/list": () =>
        buildJsonResponse(201, { llms: [], modelLoading: "lys" })
    })

    await expect(listModels("lmStudio", createConnection())).rejects.toThrow(
      Error
    )
  })

  it("marks a runtime-unavailable refusal so callers can recognize it", async () => {
    const failure = await getListModelsFailure(
      buildJsonResponse(
        503,
        createLlmRuntimeUnavailableProblem("LM Studio is not connected.")
      )
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: "LM Studio is not connected." })
    expect(isModelRuntimeUnavailableError(failure)).toBe(true)
  })

  it("reports a queue refusal with its declared detail and no runtime mark", async () => {
    const busy = createLlmServiceBusyProblem()

    const failure = await getListModelsFailure(buildJsonResponse(503, busy))

    expect(failure).toMatchObject({ message: busy.detail })
    expect(isModelRuntimeUnavailableError(failure)).toBe(false)
  })

  it("withholds the detail of a problem whose status does not match", async () => {
    const failure = await getListModelsFailure(
      buildJsonResponse(
        500,
        createLlmRuntimeUnavailableProblem("Internal path /Users/secret")
      )
    )

    expect(failure).toMatchObject({ message: expect.stringContaining("500") })
    expect(failure).not.toMatchObject({
      message: expect.stringContaining("/Users/secret")
    })
    expect(isModelRuntimeUnavailableError(failure)).toBe(false)
  })

  it("does not treat a queue-refusal body under another status as a refusal", async () => {
    const busy = createLlmServiceBusyProblem()

    const failure = await getListModelsFailure(buildJsonResponse(500, busy))

    expect(failure).toMatchObject({ message: expect.stringContaining("500") })
    expect(failure).not.toMatchObject({ message: busy.detail })
  })

  it("withholds an undeclared error body", async () => {
    const failure = await getListModelsFailure(
      buildJsonResponse(500, { detail: "stack trace at /Users/secret" })
    )

    expect(failure).toMatchObject({ message: expect.stringContaining("500") })
    expect(failure).not.toMatchObject({
      message: expect.stringContaining("/Users/secret")
    })
  })

  it("names the status of a failure whose body is not JSON", async () => {
    const failure = await getListModelsFailure(
      new Response("Bad Gateway", { status: 502 })
    )

    expect(failure).toMatchObject({ message: expect.stringContaining("502") })
  })

  it("rejects with the abort reason when the caller cancels", async () => {
    startBackendFake({
      "GET /api/v1/llm/lmStudio/list": () => new Promise<Response>(() => {})
    })
    const controller = new AbortController()

    const models = listModels("lmStudio", {
      backendUrl: FIXTURE_BACKEND_URL,
      signal: controller.signal
    })
    controller.abort()

    await expect(models).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("loadModel", () => {
  it("sends the model key and only the given load settings, and returns the loaded model", async () => {
    const loaded = buildLlmInfo("qwen3-8b", { loaded: true })
    const backend = startBackendFake({
      "POST /api/v1/llm/lmStudio/load": () => buildJsonResponse(200, loaded)
    })
    const connection = createConnection()

    await expect(
      loadModel(buildLmStudioModel("qwen3-8b"), LOAD_CONFIGURATION, connection)
    ).resolves.toEqual(loaded)
    expect(backend.requests[0]?.body).toEqual({
      modelId: "qwen3-8b",
      configuration: { contextLength: 16384, flashAttention: false }
    })
    expect(backend.requests[0]?.headers.get("Content-Type")).toBe(
      "application/json"
    )
    expect(backend.requests[0]?.signal).toBe(connection.signal)
  })

  it("rejects a load response that does not confirm the model is loaded", async () => {
    startBackendFake({
      "POST /api/v1/llm/lmStudio/load": () =>
        buildJsonResponse(200, buildLlmInfo("qwen3-8b", { loaded: false }))
    })

    await expect(
      loadModel(
        buildLmStudioModel("qwen3-8b"),
        LOAD_CONFIGURATION,
        createConnection()
      )
    ).rejects.toThrow(Error)
  })

  it("rejects an empty model key without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      loadModel(buildLmStudioModel(""), LOAD_CONFIGURATION, createConnection())
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })

  it("rejects a load setting below its accepted range without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      loadModel(
        buildLmStudioModel("qwen3-8b"),
        { contextLength: 0 },
        createConnection()
      )
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })

  it("marks a runtime-unavailable refusal", async () => {
    startBackendFake({
      "POST /api/v1/llm/lmStudio/load": () =>
        buildJsonResponse(
          503,
          createLlmRuntimeUnavailableProblem("LM Studio is not connected.")
        )
    })

    const failure = await loadModel(
      buildLmStudioModel("qwen3-8b"),
      LOAD_CONFIGURATION,
      createConnection()
    ).catch((error: unknown) => error)

    expect(isModelRuntimeUnavailableError(failure)).toBe(true)
  })

  it("reports a refusal by a provider that loads its own models with its detail and no runtime mark", async () => {
    startBackendFake({
      "POST /api/v1/llm/lmStudio/load": () =>
        buildJsonResponse(
          409,
          createLlmProviderLoadsModelsProblem("Groq loads its own models.")
        )
    })

    const failure = await loadModel(
      buildLmStudioModel("qwen3-8b"),
      LOAD_CONFIGURATION,
      createConnection()
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ message: "Groq loads its own models." })
    expect(isModelRuntimeUnavailableError(failure)).toBe(false)
  })
})

describe("unloadModel", () => {
  it("resolves for the bodyless acknowledgement after sending only the model key", async () => {
    const backend = startBackendFake({
      "PATCH /api/v1/llm/lmStudio/unload": () =>
        new Response(null, { status: 204 })
    })

    await expect(
      unloadModel(buildLmStudioModel("qwen3-8b"), createConnection())
    ).resolves.toBeUndefined()
    expect(backend.requests[0]?.body).toEqual({ modelId: "qwen3-8b" })
  })

  it("rejects an unexpected success status", async () => {
    startBackendFake({
      "PATCH /api/v1/llm/lmStudio/unload": () => buildJsonResponse(200, {})
    })

    await expect(
      unloadModel(buildLmStudioModel("qwen3-8b"), createConnection())
    ).rejects.toThrow(Error)
  })

  it.each([
    ["model-not-found", 404],
    ["unload-failed", 503]
  ] as const)(
    "reports a declared %s problem with its detail and no runtime mark",
    async (reason, status) => {
      const problem = createLlmUnloadProblem({
        reason,
        detail: `Declared ${reason} detail.`
      })
      startBackendFake({
        "PATCH /api/v1/llm/lmStudio/unload": () =>
          buildJsonResponse(status, problem)
      })

      const failure = await unloadModel(
        buildLmStudioModel("qwen3-8b"),
        createConnection()
      ).catch((error: unknown) => error)

      expect(failure).toMatchObject({ message: `Declared ${reason} detail.` })
      expect(isModelRuntimeUnavailableError(failure)).toBe(false)
    }
  )

  it("reports a refusal by a provider that loads its own models with its detail", async () => {
    startBackendFake({
      "PATCH /api/v1/llm/lmStudio/unload": () =>
        buildJsonResponse(
          409,
          createLlmProviderLoadsModelsProblem("Groq loads its own models.")
        )
    })

    const failure = await unloadModel(
      buildLmStudioModel("qwen3-8b"),
      createConnection()
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ message: "Groq loads its own models." })
  })

  it("marks a runtime-unavailable refusal", async () => {
    startBackendFake({
      "PATCH /api/v1/llm/lmStudio/unload": () =>
        buildJsonResponse(
          503,
          createLlmUnloadProblem({
            reason: "runtime-unavailable",
            detail: "LM Studio is not connected."
          })
        )
    })

    const failure = await unloadModel(
      buildLmStudioModel("qwen3-8b"),
      createConnection()
    ).catch((error: unknown) => error)

    expect(isModelRuntimeUnavailableError(failure)).toBe(true)
  })

  it("rejects an empty model key without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      unloadModel(buildLmStudioModel(""), createConnection())
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })
})

describe("getModelHealth", () => {
  it("returns the observation for the requested model", async () => {
    const health = { modelId: "qwen3-8b", status: "ready", latencyMs: 12 }
    const backend = startBackendFake({
      "GET /api/v1/llm/lmStudio/qwen3-8b/health": () =>
        buildJsonResponse(200, health)
    })
    const connection = createConnection()

    await expect(
      getModelHealth(buildLmStudioModel("qwen3-8b"), connection)
    ).resolves.toEqual(health)
    expect(backend.requests[0]?.signal).toBe(connection.signal)
  })

  it("asks the provider the reference names about its model", async () => {
    const health = { modelId: "llama-3.3-70b", status: "ready", latencyMs: 40 }
    const backend = startBackendFake({
      "GET /api/v1/llm/groq/llama-3.3-70b/health": () =>
        buildJsonResponse(200, health)
    })

    await expect(
      getModelHealth(
        { provider: "groq", modelKey: "llama-3.3-70b" },
        createConnection()
      )
    ).resolves.toEqual(health)
    expect(backend.requests[0]?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/llm/groq/llama-3.3-70b/health`
    )
  })

  it("returns a not-ready observation", async () => {
    const health = {
      modelId: "qwen3-8b",
      status: "not-ready",
      reason: "model-not-loaded",
      latencyMs: 3
    }
    startBackendFake({
      "GET /api/v1/llm/lmStudio/qwen3-8b/health": () =>
        buildJsonResponse(200, health)
    })

    await expect(
      getModelHealth(buildLmStudioModel("qwen3-8b"), createConnection())
    ).resolves.toEqual(health)
  })

  it("encodes a model key that contains a path separator", async () => {
    const backend = startBackendFake({
      "GET /api/v1/llm/lmStudio/publisher%2Fmodel/health": () =>
        buildJsonResponse(200, {
          modelId: "publisher/model",
          status: "ready",
          latencyMs: 1
        })
    })

    await getModelHealth(
      buildLmStudioModel("publisher/model"),
      createConnection()
    )

    expect(backend.requests[0]?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/llm/lmStudio/publisher%2Fmodel/health`
    )
  })

  it("rejects an observation for a different model", async () => {
    startBackendFake({
      "GET /api/v1/llm/lmStudio/qwen3-8b/health": () =>
        buildJsonResponse(200, {
          modelId: "gemma-3",
          status: "ready",
          latencyMs: 1
        })
    })

    await expect(
      getModelHealth(buildLmStudioModel("qwen3-8b"), createConnection())
    ).rejects.toThrow(Error)
  })

  it("accepts a model key at the 100-character path limit", async () => {
    const modelKey = "m".repeat(100)
    startBackendFake({
      [`GET /api/v1/llm/lmStudio/${modelKey}/health`]: () =>
        buildJsonResponse(200, {
          modelId: modelKey,
          status: "ready",
          latencyMs: 1
        })
    })

    await expect(
      getModelHealth(buildLmStudioModel(modelKey), createConnection())
    ).resolves.toMatchObject({ modelId: modelKey })
  })

  it("rejects a model key over the path limit without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      getModelHealth(buildLmStudioModel("m".repeat(101)), createConnection())
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })
})

describe("isModelRuntimeUnavailableError", () => {
  it.each([
    ["a plain error", new Error("LM Studio is not connected.")],
    ["an error with another cause", new Error("x", { cause: "unavailable" })],
    ["a non-error value", { cause: "runtime-unavailable" }],
    ["undefined", undefined]
  ])("does not recognize %s", (_label, failure) => {
    expect(isModelRuntimeUnavailableError(failure)).toBe(false)
  })

  it("does not invoke a cause accessor", () => {
    const failure = new Error("x")
    let isAccessorRead = false
    Object.defineProperty(failure, "cause", {
      get: () => {
        isAccessorRead = true
        return "anything"
      }
    })

    expect(isModelRuntimeUnavailableError(failure)).toBe(false)
    expect(isAccessorRead).toBe(false)
  })

  it("does not recognize a value that cannot be inspected", () => {
    const failure = new Proxy(new Error("x"), {
      getOwnPropertyDescriptor: () => {
        throw new Error("revoked")
      }
    })

    expect(isModelRuntimeUnavailableError(failure)).toBe(false)
  })
})
