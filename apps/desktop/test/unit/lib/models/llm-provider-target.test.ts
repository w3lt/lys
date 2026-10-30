import { llmProviderSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import { describeLlmProviderTarget } from "@/lib/models/llm-provider-target"

/**
 * Builds a provider choice from the first-run one.
 *
 * @param changes - Fields the case changes.
 * @returns The validated choice.
 */
function buildProviders(changes: Record<string, unknown>) {
  return llmProviderSettingsSchema.parse({
    active: "lmStudio",
    lmStudio: { address: null },
    ollama: { mode: "local", address: null },
    ...changes
  })
}

describe("describeLlmProviderTarget", () => {
  it("reaches LM Studio at its default address while none is saved", () => {
    expect(describeLlmProviderTarget(buildProviders({}))).toEqual({
      provider: "lmStudio",
      name: "LM Studio",
      access: "address",
      location: "127.0.0.1:1234"
    })
  })

  it("reaches LM Studio at the saved address", () => {
    expect(
      describeLlmProviderTarget(
        buildProviders({ lmStudio: { address: "192.168.1.5:1234" } })
      ).location
    ).toBe("192.168.1.5:1234")
  })

  it("reaches local Ollama at an address", () => {
    expect(
      describeLlmProviderTarget(buildProviders({ active: "ollama" }))
    ).toEqual({
      provider: "ollama",
      name: "Ollama",
      access: "address",
      location: "127.0.0.1:11434"
    })
  })

  it("reaches Ollama's cloud and Groq at their hosts with a key", () => {
    expect(
      describeLlmProviderTarget(
        buildProviders({
          active: "ollama",
          ollama: { mode: "cloud", address: "192.168.1.20:11434" }
        })
      )
    ).toMatchObject({ access: "key", location: "ollama.com" })
    expect(
      describeLlmProviderTarget(buildProviders({ active: "groq" }))
    ).toEqual({
      provider: "groq",
      name: "Groq",
      access: "key",
      location: "api.groq.com"
    })
  })
})
