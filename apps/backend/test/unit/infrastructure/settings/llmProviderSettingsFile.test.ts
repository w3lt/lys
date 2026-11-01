import { describe, expect, it } from "vitest"
import {
  findLlmProviderAccess,
  readLlmProviderAccess
} from "../../../../src/infrastructure/settings/llmProviderSettingsFile"
import {
  createSettingsFilePath,
  writeSettingsFile
} from "../../support/settingsFile"

/** Synthetic Ollama key; not a real credential. */
const SYNTHETIC_OLLAMA_KEY = "ollama-synthetic-0123456789"

/** Synthetic Groq key; not a real credential. */
const SYNTHETIC_GROQ_KEY = "gsk_synthetic_0123456789"

/**
 * Builds settings file text holding every group the desktop writes.
 *
 * @param providers - Value of the `providers` group.
 * @param secrets - Value of the `secrets` group.
 * @returns The JSON text.
 */
function buildSettingsText(
  providers: unknown,
  secrets: Readonly<Record<string, unknown>>
): string {
  return JSON.stringify({
    runtime: { autoStartBackend: true, defaultModel: null },
    providers,
    secrets: { tavilyApiKey: null, ...secrets },
    futureGroup: { anything: [1, 2, 3] }
  })
}

describe("readLlmProviderAccess", () => {
  it.each([
    ["a missing providers group", "{}"],
    ["an empty providers group", '{ "providers": {} }'],
    [
      "a null LM Studio address",
      '{ "providers": { "active": "lmStudio", "lmStudio": { "address": null } } }'
    ]
  ])("reads %s as LM Studio at its default address", async (_label, text) => {
    const path = await writeSettingsFile(text)

    expect(await readLlmProviderAccess(path)).toEqual({
      status: "configured",
      access: { provider: "lmStudio", address: "127.0.0.1:1234" }
    })
  })

  it("reads a missing settings file as LM Studio at its default address", async () => {
    const path = await createSettingsFilePath()

    expect(await readLlmProviderAccess(path)).toEqual({
      status: "configured",
      access: { provider: "lmStudio", address: "127.0.0.1:1234" }
    })
  })

  it("reads a saved LM Studio address", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        { active: "lmStudio", lmStudio: { address: "studio-box.local:4321" } },
        {}
      )
    )

    const read = await readLlmProviderAccess(path)

    expect(read).toEqual({
      status: "configured",
      access: { provider: "lmStudio", address: "studio-box.local:4321" }
    })
    expect(Object.isFrozen(read)).toBe(true)
  })

  it("reads local Ollama at its saved or default address", async () => {
    const saved = await writeSettingsFile(
      buildSettingsText(
        { active: "ollama", ollama: { address: "gpu:11500" } },
        {}
      )
    )
    const unsaved = await writeSettingsFile(
      buildSettingsText({ active: "ollama" }, {})
    )

    expect(await readLlmProviderAccess(saved)).toEqual({
      status: "configured",
      access: { provider: "ollama", address: "gpu:11500" }
    })
    expect(await readLlmProviderAccess(unsaved)).toEqual({
      status: "configured",
      access: { provider: "ollama", address: "127.0.0.1:11434" }
    })
  })

  it("reads Ollama Cloud with its saved key, without the local server's address", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        { active: "ollamaCloud", ollama: { address: "gpu:11500" } },
        { ollamaApiKey: SYNTHETIC_OLLAMA_KEY, groqApiKey: "not a key" }
      )
    )

    expect(await readLlmProviderAccess(path)).toEqual({
      status: "configured",
      access: { provider: "ollamaCloud", apiKey: SYNTHETIC_OLLAMA_KEY }
    })
  })

  it("reads Groq with its saved key", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({ active: "groq" }, { groqApiKey: SYNTHETIC_GROQ_KEY })
    )

    expect(await readLlmProviderAccess(path)).toEqual({
      status: "configured",
      access: { provider: "groq", apiKey: SYNTHETIC_GROQ_KEY }
    })
  })

  it.each([
    ["Ollama Cloud", { active: "ollamaCloud" }, "ollamaCloud"],
    ["Groq", { active: "groq" }, "groq"]
  ])(
    "reads %s without a key as a missing key",
    async (_label, providers, provider) => {
      const withoutKey = await writeSettingsFile(
        buildSettingsText(providers, {})
      )
      const nullKey = await writeSettingsFile(
        buildSettingsText(providers, { ollamaApiKey: null, groqApiKey: null })
      )

      expect(await readLlmProviderAccess(withoutKey)).toEqual({
        status: "missing-key",
        provider
      })
      expect(await readLlmProviderAccess(nullKey)).toEqual({
        status: "missing-key",
        provider
      })
    }
  )

  it.each([
    ["text that is not JSON", "{ not json"],
    ["a JSON array", "[]"],
    ["an unknown provider", '{ "providers": { "active": "openai" } }'],
    [
      "an address with a scheme",
      '{ "providers": { "lmStudio": { "address": "http://127.0.0.1:1234" } } }'
    ],
    [
      "a Groq key with a space",
      '{ "providers": { "active": "groq" }, "secrets": { "groqApiKey": "gsk key" } }'
    ]
  ])("reads %s as unreadable", async (_label, text) => {
    const path = await writeSettingsFile(text)

    expect(await readLlmProviderAccess(path)).toEqual({ status: "unreadable" })
  })
})

describe("findLlmProviderAccess", () => {
  it("finds the configured access", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({ active: "groq" }, { groqApiKey: SYNTHETIC_GROQ_KEY })
    )

    expect(await findLlmProviderAccess(path)).toEqual({
      provider: "groq",
      apiKey: SYNTHETIC_GROQ_KEY
    })
  })

  it("rejects a missing key, naming only the provider", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({ active: "groq" }, {})
    )

    await expect(findLlmProviderAccess(path)).rejects.toMatchObject({
      message: "The active model provider has no saved API key.",
      cause: { message: "No API key is saved for groq." }
    })
  })

  it("rejects an unreadable file without quoting it", async () => {
    const path = await writeSettingsFile(
      `{ "secrets": { "groqApiKey": "${SYNTHETIC_GROQ_KEY}" `
    )

    const failure = await findLlmProviderAccess(path).catch(
      (error: unknown) => error
    )

    expect(failure).toEqual(new Error("The settings file could not be read."))
    expect(failure).not.toHaveProperty("cause")
  })
})
