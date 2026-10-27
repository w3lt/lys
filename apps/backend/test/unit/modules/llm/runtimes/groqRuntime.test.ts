import { groqApiKeySchema } from "@lys/share"
import { describe, expect, it, onTestFinished } from "vitest"
import GroqRuntime from "../../../../../src/modules/llm/runtimes/groqRuntime"
import {
  answerWith,
  startProviderServer,
  type ProviderServerRoute
} from "../../../support/providerServer"

/** Synthetic Groq key; not a real credential. */
const API_KEY = groqApiKeySchema.parse("gsk_synthetic_0123456789")

/** Groq's model list with one served, one unflagged, and one inactive model. */
const MODEL_LIST = {
  object: "list",
  data: [
    {
      id: "llama-3.3-70b-versatile",
      object: "model",
      active: true,
      context_window: 131_072,
      owned_by: "Meta"
    },
    { id: "openai/gpt-oss-20b", context_window: 65_536 },
    { id: "retired-model", active: false, context_window: 8192 }
  ]
}

/**
 * Starts a fake Groq and acquires a runtime for it, owned by the test.
 *
 * @param listModels - Route answering the model list; the list above when
 * omitted.
 * @returns The runtime and the server's request log.
 */
async function createOwnedRuntime(
  listModels: ProviderServerRoute = answerWith(MODEL_LIST)
) {
  const server = await startProviderServer({ "GET /models": listModels })
  const runtime = await GroqRuntime.create(server.baseUrl, API_KEY)
  onTestFinished(async () => await runtime[Symbol.asyncDispose]())
  return { runtime, server }
}

describe("GroqRuntime", () => {
  it("is acquired once Groq lists its models for the key", async () => {
    const { server } = await createOwnedRuntime()

    expect(server.requests).toEqual([
      {
        method: "GET",
        path: "/models",
        authorization: `Bearer ${API_KEY}`,
        body: undefined
      }
    ])
  })

  it("is not acquired when Groq refuses the key", async () => {
    const server = await startProviderServer({
      "GET /models": answerWith({ error: { message: "Invalid API Key" } }, 401)
    })

    const creation = GroqRuntime.create(server.baseUrl, API_KEY)

    await expect(creation).rejects.toThrow("The LLM runtime is unavailable.")
    await expect(creation).rejects.toMatchObject({
      cause: { message: "The provider answered with HTTP 401." }
    })
  })

  it("lists every served model without file metadata", async () => {
    const { runtime } = await createOwnedRuntime()

    const models = await runtime.listDownloadedLlmModels()

    expect(models).toEqual([
      {
        modelKey: "llama-3.3-70b-versatile",
        displayName: "llama-3.3-70b-versatile",
        vision: false,
        trainedForToolUse: true,
        maxContextLength: 131_072
      },
      {
        modelKey: "openai/gpt-oss-20b",
        displayName: "openai/gpt-oss-20b",
        vision: false,
        trainedForToolUse: true,
        maxContextLength: 65_536
      }
    ])
    expect(Object.isFrozen(models)).toBe(true)
    expect(Object.isFrozen(models[0])).toBe(true)
  })

  it("reports every served model as loaded", async () => {
    const { runtime } = await createOwnedRuntime()

    expect(await runtime.listLoadedLlmModelInstances()).toEqual([
      {
        modelKey: "llama-3.3-70b-versatile",
        modelIdentifier: "llama-3.3-70b-versatile"
      },
      { modelKey: "openai/gpt-oss-20b", modelIdentifier: "openai/gpt-oss-20b" }
    ])
  })

  it("measures with the context window and estimated counts", async () => {
    const { runtime } = await createOwnedRuntime()

    const measurement = await runtime.findLlmContextMeasurement(
      "openai/gpt-oss-20b",
      ["", "abcdef", "abcdefg", "東京"]
    )

    expect(measurement).toEqual({
      contextLength: 65_536,
      textTokenCounts: [0, 2, 3, 2]
    })
    expect(
      await runtime.findLlmContextMeasurement("retired-model", ["a"])
    ).toBeUndefined()
  })

  it("refuses to load or stop a model without contacting Groq", async () => {
    const { runtime, server } = await createOwnedRuntime()

    await expect(runtime.loadLlmModel()).rejects.toThrow(
      "The LLM runtime could not load the model."
    )
    await expect(runtime.stopLoadedLlmModelInstance()).rejects.toThrow(
      "The LLM runtime could not stop the model instance."
    )
    expect(server.requests).toHaveLength(1)
  })

  it("reports Groq unavailable once it stops answering", async () => {
    let status = 200
    const { runtime } = await createOwnedRuntime(() => ({
      status,
      body: MODEL_LIST
    }))

    expect(await runtime.getRuntimeAvailability()).toBe("available")
    status = 503
    expect(await runtime.getRuntimeAvailability()).toBe("unavailable")
    await expect(runtime.listDownloadedLlmModels()).rejects.toThrow(
      "The LLM runtime could not list downloaded models."
    )
  })

  it("rejects a model list that is not Groq's shape", async () => {
    let body: unknown = MODEL_LIST
    const { runtime } = await createOwnedRuntime(() => ({ status: 200, body }))
    body = { data: [{ id: "no-window" }] }

    await expect(runtime.listLoadedLlmModelInstances()).rejects.toMatchObject({
      message: "The LLM runtime could not list loaded model instances.",
      cause: { message: "Groq returned an invalid model list." }
    })
  })

  it("refuses work once disposed", async () => {
    const { runtime } = await createOwnedRuntime()

    await runtime[Symbol.asyncDispose]()

    await expect(runtime.listDownloadedLlmModels()).rejects.toThrow(
      "The LLM runtime is closed."
    )
  })
})
