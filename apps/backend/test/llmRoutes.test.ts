import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import registerLlmRoutes from "../src/modules/llm/routes/index"

const downloadedModel = {
  type: "llm" as const,
  modelKey: "publisher/model",
  format: "gguf" as const,
  displayName: "Model",
  path: "publisher/model/model.gguf",
  sizeBytes: 42,
  vision: false,
  trainedForToolUse: false,
  maxContextLength: 4096
}

function createClient() {
  return {
    llm: {
      async load(modelId: string) {
        assert.equal(modelId, "model-alias")
        return { modelKey: "publisher/model" }
      },
      async listLoaded() {
        return [{ modelKey: "publisher/model" }]
      }
    },
    system: {
      async listDownloadedModels(domain: "llm") {
        assert.equal(domain, "llm")
        return [downloadedModel]
      }
    }
  }
}

test("load route rejects a numeric modelId instead of coercing it", async () => {
  const app = Fastify()
  const client = createClient()
  client.llm.load = async () => ({ modelKey: "publisher/model" })
  await registerLlmRoutes(app, { createClient: () => client })

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/llm/load",
    payload: { modelId: 42 }
  })

  assert.equal(response.statusCode, 400)

  await app.close()
})

test("load route rejects additional body properties instead of removing them", async () => {
  const app = Fastify()
  await registerLlmRoutes(app, { createClient })

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/llm/load",
    payload: { modelId: "model-alias", extra: true }
  })

  assert.equal(response.statusCode, 400)

  await app.close()
})

test("load route validates with and serializes from the protocol contract", async () => {
  const app = Fastify()
  await registerLlmRoutes(app, { createClient })

  const invalidResponse = await app.inject({
    method: "POST",
    url: "/api/v1/llm/load",
    payload: { modelId: "" }
  })
  assert.equal(invalidResponse.statusCode, 400)

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/llm/load",
    payload: { modelId: "model-alias" }
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    modelKey: "publisher/model",
    format: "gguf",
    displayName: "Model",
    path: "publisher/model/model.gguf",
    sizeBytes: 42,
    vision: false,
    trainedForToolUse: false,
    maxContextLength: 4096,
    loaded: true
  })

  await app.close()
})

test("load route preserves Fastify's 500 response for LM Studio load failures", async () => {
  const app = Fastify()
  const client = createClient()
  client.llm.load = async () => {
    throw new Error("LM Studio load failed")
  }
  await registerLlmRoutes(app, { createClient: () => client })

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/llm/load",
    payload: { modelId: "model-alias" }
  })

  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.json(), {
    statusCode: 500,
    error: "Internal Server Error",
    message: "LM Studio load failed"
  })

  await app.close()
})

test("load route returns the invariant error when the canonical model key is missing", async () => {
  const app = Fastify()
  const client = createClient()
  client.llm.load = async (modelId: string) => {
    assert.equal(modelId, "model-alias")
    return { modelKey: "publisher/missing" }
  }
  await registerLlmRoutes(app, { createClient: () => client })

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/llm/load",
    payload: { modelId: "model-alias" }
  })

  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.json(), {
    statusCode: 500,
    error: "Internal Server Error",
    message:
      'Loaded model "publisher/missing" was not found in the downloaded LLM inventory'
  })

  await app.close()
})

test("list route serializes its response from the protocol contract", async () => {
  const app = Fastify()
  await registerLlmRoutes(app, { createClient })

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/llm/list"
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    llms: [
      {
        modelKey: "publisher/model",
        format: "gguf",
        displayName: "Model",
        path: "publisher/model/model.gguf",
        sizeBytes: 42,
        vision: false,
        trainedForToolUse: false,
        maxContextLength: 4096,
        loaded: true
      }
    ]
  })

  await app.close()
})
