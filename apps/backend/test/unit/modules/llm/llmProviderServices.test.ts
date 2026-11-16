import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { buildLlmProviderRecord } from "../../../../src/modules/llm/llmProviderServices"

describe("buildLlmProviderRecord", () => {
  it("builds one value for each provider, once each and in provider order", () => {
    const buildValue = vi.fn((provider: LlmProvider) => `${provider}-value`)

    const record = buildLlmProviderRecord(buildValue)

    expect(buildValue.mock.calls).toEqual(
      LLM_PROVIDERS.map((provider) => [provider])
    )
    expect(record).toEqual({
      lmStudio: "lmStudio-value",
      ollama: "ollama-value",
      ollamaCloud: "ollamaCloud-value",
      groq: "groq-value"
    })
  })

  it("returns a frozen record", () => {
    expect(Object.isFrozen(buildLlmProviderRecord(() => 0))).toBe(true)
  })
})
