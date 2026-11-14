import { llmProviderSettingsSchema, ollamaApiKeySchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  describeLlmProviderTarget,
  findSavedProviderApiKey,
  isLlmProviderKeyMissing
} from "@/lib/models/llm-provider-target"
import type { SecretsSettings } from "@/lib/store/settings"
import {
  STORED_GROQ_API_KEY,
  STORED_SETTINGS
} from "../../support/settingsFixtures"

/** Ollama key a case saves: a made-up value of a key's shape. */
const OLLAMA_API_KEY = ollamaApiKeySchema.parse("ollama-fixture-3333333")

/** Saved keys with neither provider key. */
const NO_PROVIDER_KEYS: SecretsSettings = Object.freeze({
  ...STORED_SETTINGS.secrets,
  ollamaApiKey: null,
  groqApiKey: null
})

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

describe("findSavedProviderApiKey", () => {
  it("finds each keyed provider's own key", () => {
    const secrets: SecretsSettings = {
      ...STORED_SETTINGS.secrets,
      ollamaApiKey: OLLAMA_API_KEY
    }

    expect(findSavedProviderApiKey("ollamaCloud", secrets)).toBe(OLLAMA_API_KEY)
    expect(findSavedProviderApiKey("groq", secrets)).toBe(STORED_GROQ_API_KEY)
  })

  it("finds no key while none is saved", () => {
    expect(findSavedProviderApiKey("groq", NO_PROVIDER_KEYS)).toBeNull()
  })
})

describe("isLlmProviderKeyMissing", () => {
  it.each(["ollamaCloud", "groq"] as const)(
    "says %s needs a key while none is saved",
    (provider) => {
      expect(isLlmProviderKeyMissing(provider, NO_PROVIDER_KEYS)).toBe(true)
    }
  )

  it("says a keyed provider with its key saved lacks none", () => {
    expect(isLlmProviderKeyMissing("groq", STORED_SETTINGS.secrets)).toBe(false)
  })

  it.each(["lmStudio", "ollama"] as const)(
    "never says %s, reached at an address, needs a key",
    (provider) => {
      expect(isLlmProviderKeyMissing(provider, NO_PROVIDER_KEYS)).toBe(false)
    }
  )
})
