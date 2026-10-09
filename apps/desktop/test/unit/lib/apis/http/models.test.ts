import {
  createLlmRuntimeUnavailableProblem,
  createLlmServiceBusyProblem,
  createLlmUnloadProblem
} from "@lys/protocol"
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
  startBackendFake
} from "../../../support/backendFake"
import { buildLlmInfo } from "../../../support/modelFixtures"

/** Backend origin the cases pass; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/**
 * Builds a connection the case does not cancel.
 *
 * @returns The connection and its signal, which the request must carry.
 */
function createConnection() {
  return { backendUrl: BACKEND_URL, signal: new AbortController().signal }
}

/**
 * Lists models through a backend that fails the list request.
 *
 * @param response - Failure response the backend sends.
 * @returns The rejection reason of the list request.
 */
async function getListModelsFailure(response: Response): Promise<unknown> {
  startBackendFake({ "GET /api/v1/llm/list": () => response })
  return await listModels(createConnection()).catch((error: unknown) => error)
}

describe("listModels", () => {
  it("returns the listed models after a validated response", async () => {
    const models = [
      buildLlmInfo("qwen3-8b", { loaded: true }),
      buildLlmInfo("gemma-3")
    ]
    const backend = startBackendFake({
      "GET /api/v1/llm/list": () => buildJsonResponse(200, { llms: models })
    })
    const connection = createConnection()

    await expect(listModels(connection)).resolves.toEqual(models)
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]?.url).toBe(`${BACKEND_URL}/api/v1/llm/list`)
    expect(backend.requests[0]?.signal).toBe(connection.signal)
    expect(backend.requests[0]?.cache).toBe("no-store")
  })

  it("rejects a list that names a model twice", async () => {
    const model = buildLlmInfo("qwen3-8b")
    startBackendFake({
      "GET /api/v1/llm/list": () =>
        buildJsonResponse(200, { llms: [model, model] })
    })

    await expect(listModels(createConnection())).rejects.toThrow(Error)
  })

  it("rejects a list containing an empty model key", async () => {
    startBackendFake({
      "GET /api/v1/llm/list": () =>
        buildJsonResponse(200, { llms: [buildLlmInfo("")] })
    })

    await expect(listModels(createConnection())).rejects.toThrow(Error)
  })

  it("rejects a malformed list and keeps the decoding failure as its cause", async () => {
    startBackendFake({
      "GET /api/v1/llm/list": () =>
        buildJsonResponse(200, { llms: [{ modelKey: "raw-secret" }] })
    })

    const models = listModels(createConnection())

    await expect(models).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
    await expect(models).rejects.not.toThrow("raw-secret")
  })

  it("rejects a success response that is not JSON", async () => {
    startBackendFake({
      "GET /api/v1/llm/list": () =>
        new Response(JSON.stringify({ llms: [] }), {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        })
    })

    await expect(listModels(createConnection())).rejects.toThrow(Error)
  })

  it("rejects a success status other than 200", async () => {
    startBackendFake({
      "GET /api/v1/llm/list": () => buildJsonResponse(201, { llms: [] })
    })

    await expect(listModels(createConnection())).rejects.toThrow(Error)
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
      "GET /api/v1/llm/list": () => new Promise<Response>(() => {})
    })
    const controller = new AbortController()

    const models = listModels({
      backendUrl: BACKEND_URL,
      signal: controller.signal
    })
    controller.abort()

    await expect(models).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("loadModel", () => {
  it("sends only the model key and returns the loaded model", async () => {
    const loaded = buildLlmInfo("qwen3-8b", { loaded: true })
    const backend = startBackendFake({
      "POST /api/v1/llm/load": () => buildJsonResponse(200, loaded)
    })
    const connection = createConnection()

    await expect(loadModel("qwen3-8b", connection)).resolves.toEqual(loaded)
    expect(backend.requests[0]?.body).toEqual({ modelId: "qwen3-8b" })
    expect(backend.requests[0]?.headers.get("Content-Type")).toBe(
      "application/json"
    )
    expect(backend.requests[0]?.signal).toBe(connection.signal)
  })

  it("rejects a load response that does not confirm the model is loaded", async () => {
    startBackendFake({
      "POST /api/v1/llm/load": () =>
        buildJsonResponse(200, buildLlmInfo("qwen3-8b", { loaded: false }))
    })

    await expect(loadModel("qwen3-8b", createConnection())).rejects.toThrow(
      Error
    )
  })

  it("rejects an empty model key without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(loadModel("", createConnection())).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })

  it("marks a runtime-unavailable refusal", async () => {
    startBackendFake({
      "POST /api/v1/llm/load": () =>
        buildJsonResponse(
          503,
          createLlmRuntimeUnavailableProblem("LM Studio is not connected.")
        )
    })

    const failure = await loadModel("qwen3-8b", createConnection()).catch(
      (error: unknown) => error
    )

    expect(isModelRuntimeUnavailableError(failure)).toBe(true)
  })
})

describe("unloadModel", () => {
  it("resolves for the bodyless acknowledgement after sending only the model key", async () => {
    const backend = startBackendFake({
      "PATCH /api/v1/llm/unload": () => new Response(null, { status: 204 })
    })

    await expect(
      unloadModel("qwen3-8b", createConnection())
    ).resolves.toBeUndefined()
    expect(backend.requests[0]?.body).toEqual({ modelId: "qwen3-8b" })
  })

  it("rejects an unexpected success status", async () => {
    startBackendFake({
      "PATCH /api/v1/llm/unload": () => buildJsonResponse(200, {})
    })

    await expect(unloadModel("qwen3-8b", createConnection())).rejects.toThrow(
      Error
    )
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
        "PATCH /api/v1/llm/unload": () => buildJsonResponse(status, problem)
      })

      const failure = await unloadModel("qwen3-8b", createConnection()).catch(
        (error: unknown) => error
      )

      expect(failure).toMatchObject({ message: `Declared ${reason} detail.` })
      expect(isModelRuntimeUnavailableError(failure)).toBe(false)
    }
  )

  it("marks a runtime-unavailable refusal", async () => {
    startBackendFake({
      "PATCH /api/v1/llm/unload": () =>
        buildJsonResponse(
          503,
          createLlmUnloadProblem({
            reason: "runtime-unavailable",
            detail: "LM Studio is not connected."
          })
        )
    })

    const failure = await unloadModel("qwen3-8b", createConnection()).catch(
      (error: unknown) => error
    )

    expect(isModelRuntimeUnavailableError(failure)).toBe(true)
  })

  it("rejects an empty model key without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(unloadModel("", createConnection())).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })
})

describe("getModelHealth", () => {
  it("returns the observation for the requested model", async () => {
    const health = { modelId: "qwen3-8b", status: "ready", latencyMs: 12 }
    const backend = startBackendFake({
      "GET /api/v1/llm/qwen3-8b/health": () => buildJsonResponse(200, health)
    })
    const connection = createConnection()

    await expect(getModelHealth("qwen3-8b", connection)).resolves.toEqual(
      health
    )
    expect(backend.requests[0]?.signal).toBe(connection.signal)
  })

  it("returns a not-ready observation", async () => {
    const health = {
      modelId: "qwen3-8b",
      status: "not-ready",
      reason: "model-not-loaded",
      latencyMs: 3
    }
    startBackendFake({
      "GET /api/v1/llm/qwen3-8b/health": () => buildJsonResponse(200, health)
    })

    await expect(
      getModelHealth("qwen3-8b", createConnection())
    ).resolves.toEqual(health)
  })

  it("encodes a model key that contains a path separator", async () => {
    const backend = startBackendFake({
      "GET /api/v1/llm/publisher%2Fmodel/health": () =>
        buildJsonResponse(200, {
          modelId: "publisher/model",
          status: "ready",
          latencyMs: 1
        })
    })

    await getModelHealth("publisher/model", createConnection())

    expect(backend.requests[0]?.url).toBe(
      `${BACKEND_URL}/api/v1/llm/publisher%2Fmodel/health`
    )
  })

  it("rejects an observation for a different model", async () => {
    startBackendFake({
      "GET /api/v1/llm/qwen3-8b/health": () =>
        buildJsonResponse(200, {
          modelId: "gemma-3",
          status: "ready",
          latencyMs: 1
        })
    })

    await expect(
      getModelHealth("qwen3-8b", createConnection())
    ).rejects.toThrow(Error)
  })

  it("accepts a model key at the 100-character path limit", async () => {
    const modelKey = "m".repeat(100)
    startBackendFake({
      [`GET /api/v1/llm/${modelKey}/health`]: () =>
        buildJsonResponse(200, {
          modelId: modelKey,
          status: "ready",
          latencyMs: 1
        })
    })

    await expect(
      getModelHealth(modelKey, createConnection())
    ).resolves.toMatchObject({ modelId: modelKey })
  })

  it("rejects a model key over the path limit without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      getModelHealth("m".repeat(101), createConnection())
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
