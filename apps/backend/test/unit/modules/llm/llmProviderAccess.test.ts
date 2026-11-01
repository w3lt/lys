import {
  groqApiKeySchema,
  ollamaApiKeySchema,
  providerAddressSchema
} from "@lys/share"
import { describe, expect, it } from "vitest"
import { buildLlmChatEndpoint } from "../../../../src/modules/llm/llmProviderAccess"

/** Saved server address, the same for both local providers. */
const ADDRESS = providerAddressSchema.parse("gpu-box.local:1234")

/** Ollama Cloud key: a made-up value of a key's shape. */
const OLLAMA_KEY = ollamaApiKeySchema.parse("ollama-synthetic-0123456789")

/** Groq key: a made-up value of a key's shape. */
const GROQ_KEY = groqApiKeySchema.parse("gsk_synthetic_0123456789")

describe("buildLlmChatEndpoint", () => {
  it("reaches LM Studio at its address, reading the reply ceiling from max_completion_tokens", () => {
    const endpoint = buildLlmChatEndpoint({
      provider: "lmStudio",
      address: ADDRESS
    })

    expect(endpoint).toEqual({
      baseUrl: "http://gpu-box.local:1234/v1",
      apiKey: undefined,
      replyCeilingField: "max_completion_tokens"
    })
    expect(Object.isFrozen(endpoint)).toBe(true)
  })

  it("reaches a local Ollama server and Ollama Cloud, both reading the reply ceiling from max_tokens", () => {
    expect(
      buildLlmChatEndpoint({ provider: "ollama", address: ADDRESS })
    ).toEqual({
      baseUrl: "http://gpu-box.local:1234/v1",
      apiKey: undefined,
      replyCeilingField: "max_tokens"
    })
    expect(
      buildLlmChatEndpoint({ provider: "ollamaCloud", apiKey: OLLAMA_KEY })
    ).toEqual({
      baseUrl: "https://ollama.com/v1",
      apiKey: OLLAMA_KEY,
      replyCeilingField: "max_tokens"
    })
  })

  it("reaches Groq with its key, reading the reply ceiling from max_completion_tokens", () => {
    expect(
      buildLlmChatEndpoint({ provider: "groq", apiKey: GROQ_KEY })
    ).toEqual({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: GROQ_KEY,
      replyCeilingField: "max_completion_tokens"
    })
  })
})
