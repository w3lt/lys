import { llmProviderSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import { describeLlmProviderTarget } from "@/lib/models/llm-provider-target"

/**
 * Builds providers from the first-run ones.
 *
 * @param changes - Fields the case changes.
 * @returns The validated providers.
 */
function buildProviders(changes: Record<string, unknown>) {
  return llmProviderSettingsSchema.parse({
    enabled: ["lmStudio"],
    lmStudio: { address: null },
    ollama: { address: null },
    ...changes
  })
}

describe("describeLlmProviderTarget", () => {
  it("reaches LM Studio at its default address while none is saved", () => {
    expect(describeLlmProviderTarget("lmStudio", buildProviders({}))).toEqual({
      provider: "lmStudio",
      name: "LM Studio",
      access: "address",
      location: "127.0.0.1:1234"
    })
  })

  it("reaches LM Studio at the saved address", () => {
    expect(
      describeLlmProviderTarget(
        "lmStudio",
        buildProviders({ lmStudio: { address: "192.168.1.5:1234" } })
      ).location
    ).toBe("192.168.1.5:1234")
  })

  it("reaches local Ollama at an address", () => {
    expect(
      describeLlmProviderTarget(
        "ollama",
        buildProviders({ enabled: ["ollama"] })
      )
    ).toEqual({
      provider: "ollama",
      name: "Ollama",
      access: "address",
      location: "127.0.0.1:11434"
    })
  })

  it("reaches Ollama Cloud and Groq at their hosts with a key", () => {
    const providers = buildProviders({
      enabled: ["ollamaCloud", "groq"],
      ollama: { address: "192.168.1.20:11434" }
    })

    expect(describeLlmProviderTarget("ollamaCloud", providers)).toEqual({
      provider: "ollamaCloud",
      name: "Ollama Cloud",
      access: "key",
      location: "ollama.com"
    })
    expect(describeLlmProviderTarget("groq", providers)).toEqual({
      provider: "groq",
      name: "Groq",
      access: "key",
      location: "api.groq.com"
    })
  })

  it("describes a provider that is off where it would be reached", () => {
    expect(
      describeLlmProviderTarget(
        "ollama",
        buildProviders({
          enabled: ["lmStudio"],
          ollama: { address: "192.168.1.20:11434" }
        })
      ).location
    ).toBe("192.168.1.20:11434")
  })
})
