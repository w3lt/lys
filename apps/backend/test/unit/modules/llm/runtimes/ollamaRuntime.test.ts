import { ollamaApiKeySchema } from "@lys/share"
import { describe, expect, it, onTestFinished } from "vitest"
import OllamaRuntime, {
  type OllamaRuntimeTarget
} from "../../../../../src/modules/llm/runtimes/ollamaRuntime"
import {
  answerWith,
  startProviderServer,
  type ProviderServerRoute
} from "../../../support/providerServer"

/** Synthetic Ollama key; not a real credential. */
const API_KEY = ollamaApiKeySchema.parse("ollama-synthetic-0123456789")

/** `/api/tags` answer of a server with one local and one hosted model. */
const TAG_LIST = {
  models: [
    {
      name: "qwen3:8b",
      model: "qwen3:8b",
      size: 5_225_388_164,
      details: {
        format: "gguf",
        family: "qwen3",
        parameter_size: "8.2B",
        quantization_level: "Q4_K_M"
      }
    },
    { name: "gpt-oss:120b", size: 0, details: { format: "" } }
  ]
}

/** `/api/show` answers by model name. */
const SHOW_ANSWERS: Readonly<Record<string, unknown>> = {
  "qwen3:8b": {
    capabilities: ["completion", "tools", "thinking"],
    model_info: {
      "general.architecture": "qwen3",
      "qwen3.context_length": 40_960
    }
  },
  "gpt-oss:120b": {
    capabilities: ["completion", "vision"],
    model_info: { "gptoss.context_length": 131_072 }
  }
}

/** Answers `/api/show` from {@link SHOW_ANSWERS}. */
const showModel: ProviderServerRoute = (request) => {
  const model = (request.body as { model: string }).model
  return { status: 200, body: SHOW_ANSWERS[model] }
}

/**
 * Starts a fake Ollama and acquires a runtime for it, owned by the test.
 *
 * @param mode - Local server or cloud.
 * @param routes - Routes that replace the defaults.
 * @returns The runtime and the server's request log.
 */
async function createOwnedRuntime(
  mode: OllamaRuntimeTarget["mode"],
  routes: Readonly<Record<string, ProviderServerRoute>> = {}
) {
  const server = await startProviderServer({
    "GET /api/tags": answerWith(TAG_LIST),
    "POST /api/show": showModel,
    "GET /api/ps": answerWith({ models: [] }),
    ...routes
  })
  const target: OllamaRuntimeTarget =
    mode === "local"
      ? { mode, apiBaseUrl: server.baseUrl }
      : { mode, apiBaseUrl: server.baseUrl, apiKey: API_KEY }
  const runtime = await OllamaRuntime.create(target)
  onTestFinished(async () => await runtime[Symbol.asyncDispose]())
  return { runtime, server }
}

describe("OllamaRuntime", () => {
  it("lists models with their files, capabilities, and windows", async () => {
    const { runtime } = await createOwnedRuntime("local")

    const models = await runtime.listDownloadedLlmModels()

    expect(models).toEqual([
      {
        modelKey: "qwen3:8b",
        displayName: "qwen3:8b",
        format: "gguf",
        sizeBytes: 5_225_388_164,
        paramsString: "8.2B",
        architecture: "qwen3",
        vision: false,
        trainedForToolUse: true,
        maxContextLength: 40_960
      },
      {
        modelKey: "gpt-oss:120b",
        displayName: "gpt-oss:120b",
        vision: true,
        trainedForToolUse: false,
        maxContextLength: 131_072
      }
    ])
    expect(Object.isFrozen(models)).toBe(true)
  })

  it("sends no key to a local server and the key to Ollama's cloud", async () => {
    const local = await createOwnedRuntime("local")
    const cloud = await createOwnedRuntime("cloud")

    await local.runtime.listDownloadedLlmModels()
    await cloud.runtime.listDownloadedLlmModels()

    expect(
      local.server.requests.map((request) => request.authorization)
    ).toEqual([undefined, undefined, undefined, undefined])
    expect(
      cloud.server.requests.map((request) => request.authorization)
    ).toEqual(Array(4).fill(`Bearer ${API_KEY}`))
  })

  it("reports every listed model as loaded", async () => {
    const { runtime } = await createOwnedRuntime("local")

    expect(await runtime.listLoadedLlmModelInstances()).toEqual([
      { modelKey: "qwen3:8b", modelIdentifier: "qwen3:8b" },
      { modelKey: "gpt-oss:120b", modelIdentifier: "gpt-oss:120b" }
    ])
  })

  it("rejects a model whose metadata holds no context length", async () => {
    const { runtime } = await createOwnedRuntime("local", {
      "POST /api/show": answerWith({ capabilities: ["completion"] })
    })

    await expect(runtime.listDownloadedLlmModels()).rejects.toThrow(
      "The LLM runtime returned invalid model metadata."
    )
  })

  it("measures a running local model with the window it runs with", async () => {
    const { runtime, server } = await createOwnedRuntime("local", {
      "GET /api/ps": answerWith({
        models: [{ name: "qwen3:8b", model: "qwen3:8b", context_length: 4096 }]
      })
    })

    const measurement = await runtime.findLlmContextMeasurement("qwen3:8b", [
      "abcdef"
    ])

    expect(measurement).toEqual({ contextLength: 4096, textTokenCounts: [2] })
    expect(server.requests.map((request) => request.path)).not.toContain(
      "/api/show"
    )
  })

  it("measures a model that is not running with its own window", async () => {
    const { runtime } = await createOwnedRuntime("local")

    expect(await runtime.findLlmContextMeasurement("gpt-oss:120b", [])).toEqual(
      { contextLength: 131_072, textTokenCounts: [] }
    )
  })

  it("measures a cloud model without asking for running models", async () => {
    const { runtime, server } = await createOwnedRuntime("cloud")

    await runtime.findLlmContextMeasurement("qwen3:8b", ["a"])

    expect(server.requests.map((request) => request.path)).not.toContain(
      "/api/ps"
    )
  })

  it("finds no measurement for a model Ollama does not list", async () => {
    const { runtime } = await createOwnedRuntime("local")

    expect(
      await runtime.findLlmContextMeasurement("llama3:8b", ["a"])
    ).toBeUndefined()
  })

  it("refuses to load or stop a model without contacting Ollama", async () => {
    const { runtime, server } = await createOwnedRuntime("local")

    await expect(runtime.loadLlmModel()).rejects.toThrow(
      "The LLM runtime could not load the model."
    )
    await expect(runtime.stopLoadedLlmModelInstance()).rejects.toThrow(
      "The LLM runtime could not stop the model instance."
    )
    expect(server.requests).toHaveLength(1)
  })

  it("is not acquired when the server does not answer its model list", async () => {
    const server = await startProviderServer({
      "GET /api/tags": answerWith({ error: "unauthorized" }, 401)
    })

    await expect(
      OllamaRuntime.create({
        mode: "cloud",
        apiBaseUrl: server.baseUrl,
        apiKey: API_KEY
      })
    ).rejects.toThrow("The LLM runtime is unavailable.")
  })

  it("reports Ollama unavailable once it stops answering", async () => {
    let status = 200
    const { runtime } = await createOwnedRuntime("local", {
      "GET /api/tags": () => ({ status, body: TAG_LIST })
    })

    expect(await runtime.getRuntimeAvailability()).toBe("available")
    status = 500
    expect(await runtime.getRuntimeAvailability()).toBe("unavailable")
  })
})
