import assert from "node:assert/strict"
import { test } from "node:test"
import * as protocol from "@lys/protocol"

type RuntimeSchema = {
  parse(value: unknown): unknown
  safeParse(value: unknown): { success: boolean }
}

type RuntimeContract = {
  method: string
  path: string
  body?: RuntimeSchema
  response: RuntimeSchema
}

function contract(name: string): RuntimeContract {
  const value = (protocol as Record<string, unknown>)[name]
  assert.ok(value, `${name} must be exported by @lys/protocol`)
  return value as RuntimeContract
}

test("load-model contract owns its method, path, body, and response", () => {
  const api = contract("llmLoadModelApi")

  assert.equal(api.method, "POST")
  assert.equal(api.path, "/api/v1/llm/load")
  assert.ok(api.body)
  assert.deepEqual(api.body.parse({ modelId: "publisher/model" }), {
    modelId: "publisher/model"
  })
  assert.equal(api.body.safeParse({ modelId: "" }).success, false)
  assert.equal(api.body.safeParse({}).success, false)
  assert.equal(
    api.body.safeParse({ modelId: "publisher/model", extra: true }).success,
    false
  )
})

test("list-models contract owns its method, path, and response", () => {
  const api = contract("llmListModelsApi")

  assert.equal(api.method, "GET")
  assert.equal(api.path, "/api/v1/llm/list")
  assert.deepEqual(api.response.parse({ llms: [] }), { llms: [] })
})

test("shared LLM response schema validates the public model shape", () => {
  const schema = (protocol as Record<string, unknown>)
    .llmInfoSchema as RuntimeSchema

  assert.ok(schema, "llmInfoSchema must be exported by @lys/protocol")
  assert.equal(
    schema.safeParse({
      modelKey: "publisher/model",
      format: "gguf",
      displayName: "Model",
      path: "publisher/model/model.gguf",
      sizeBytes: 42,
      vision: false,
      trainedForToolUse: false,
      maxContextLength: 4096,
      loaded: true
    }).success,
    true
  )
  assert.equal(schema.safeParse({ modelKey: "publisher/model" }).success, false)
})
