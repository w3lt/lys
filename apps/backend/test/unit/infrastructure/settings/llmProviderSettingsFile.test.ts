import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
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

/**
 * Reads every provider from one settings file.
 *
 * @param path - Absolute path of the settings file.
 * @returns The status of each provider's read, by provider.
 */
async function readEveryProviderStatus(
  path: string
): Promise<Readonly<Record<LlmProvider, string>>> {
  return {
    lmStudio: (await readLlmProviderAccess(path, "lmStudio")).status,
    ollama: (await readLlmProviderAccess(path, "ollama")).status,
    ollamaCloud: (await readLlmProviderAccess(path, "ollamaCloud")).status,
    groq: (await readLlmProviderAccess(path, "groq")).status
  }
}

describe("readLlmProviderAccess", () => {
  it.each([
    ["a missing providers group", "{}"],
    ["an empty providers group", '{ "providers": {} }'],
    [
      "a legacy LM Studio choice with a null address",
      '{ "providers": { "active": "lmStudio", "lmStudio": { "address": null } } }'
    ]
  ])(
    "reads %s as LM Studio on at its default address and every other provider off",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      expect(await readLlmProviderAccess(path, "lmStudio")).toEqual({
        status: "configured",
        access: { provider: "lmStudio", address: "127.0.0.1:1234" }
      })
      expect(await readEveryProviderStatus(path)).toEqual({
        lmStudio: "configured",
        ollama: "off",
        ollamaCloud: "off",
        groq: "off"
      })
    }
  )

  it("reads a missing settings file as LM Studio on at its default address and every other provider off", async () => {
    const path = await createSettingsFilePath()

    expect(await readLlmProviderAccess(path, "lmStudio")).toEqual({
      status: "configured",
      access: { provider: "lmStudio", address: "127.0.0.1:1234" }
    })
    expect(await readEveryProviderStatus(path)).toEqual({
      lmStudio: "configured",
      ollama: "off",
      ollamaCloud: "off",
      groq: "off"
    })
  })

  it("reads every provider the enabled list names as on, each with its own access", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        {
          enabled: ["groq", "lmStudio", "ollama", "ollamaCloud"],
          lmStudio: { address: "studio-box.local:4321" },
          ollama: { address: "gpu:11500" }
        },
        { ollamaApiKey: SYNTHETIC_OLLAMA_KEY, groqApiKey: SYNTHETIC_GROQ_KEY }
      )
    )

    const lmStudio = await readLlmProviderAccess(path, "lmStudio")

    expect(lmStudio).toEqual({
      status: "configured",
      access: { provider: "lmStudio", address: "studio-box.local:4321" }
    })
    expect(Object.isFrozen(lmStudio)).toBe(true)
    expect(await readLlmProviderAccess(path, "ollama")).toEqual({
      status: "configured",
      access: { provider: "ollama", address: "gpu:11500" }
    })
    expect(await readLlmProviderAccess(path, "ollamaCloud")).toEqual({
      status: "configured",
      access: { provider: "ollamaCloud", apiKey: SYNTHETIC_OLLAMA_KEY }
    })
    expect(await readLlmProviderAccess(path, "groq")).toEqual({
      status: "configured",
      access: { provider: "groq", apiKey: SYNTHETIC_GROQ_KEY }
    })
  })

  it("reads a provider the enabled list leaves out as off, even with its address and key saved", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        {
          enabled: ["groq"],
          lmStudio: { address: "studio-box.local:4321" }
        },
        { ollamaApiKey: SYNTHETIC_OLLAMA_KEY, groqApiKey: SYNTHETIC_GROQ_KEY }
      )
    )

    expect(await readEveryProviderStatus(path)).toEqual({
      lmStudio: "off",
      ollama: "off",
      ollamaCloud: "off",
      groq: "configured"
    })
    expect(await readLlmProviderAccess(path, "lmStudio")).toEqual({
      status: "off"
    })
  })

  it("reads an empty enabled list as every provider off, whatever a legacy active provider names", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({ enabled: [], active: "lmStudio" }, {})
    )

    expect(await readEveryProviderStatus(path)).toEqual({
      lmStudio: "off",
      ollama: "off",
      ollamaCloud: "off",
      groq: "off"
    })
  })

  it("ignores a legacy active provider when the enabled list is present", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        { enabled: ["ollama"], active: "groq" },
        { groqApiKey: SYNTHETIC_GROQ_KEY }
      )
    )

    expect(await readEveryProviderStatus(path)).toEqual({
      lmStudio: "off",
      ollama: "configured",
      ollamaCloud: "off",
      groq: "off"
    })
  })

  it.each<readonly [LlmProvider, unknown]>([
    ["lmStudio", { provider: "lmStudio", address: "studio-box.local:4321" }],
    ["ollama", { provider: "ollama", address: "127.0.0.1:11434" }],
    ["ollamaCloud", { provider: "ollamaCloud", apiKey: SYNTHETIC_OLLAMA_KEY }],
    ["groq", { provider: "groq", apiKey: SYNTHETIC_GROQ_KEY }]
  ])(
    "reads a file without an enabled list whose active provider is %s as that one provider on",
    async (active, access) => {
      const path = await writeSettingsFile(
        buildSettingsText(
          { active, lmStudio: { address: "studio-box.local:4321" } },
          {
            ollamaApiKey: SYNTHETIC_OLLAMA_KEY,
            groqApiKey: SYNTHETIC_GROQ_KEY
          }
        )
      )

      expect(await readLlmProviderAccess(path, active)).toEqual({
        status: "configured",
        access
      })
      const others = LLM_PROVIDERS.filter((provider) => provider !== active)
      for (const provider of others) {
        expect(await readLlmProviderAccess(path, provider)).toEqual({
          status: "off"
        })
      }
    }
  )

  it("reads Ollama Cloud with its key, without the local server's address", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        { enabled: ["ollamaCloud"], ollama: { address: "gpu:11500" } },
        { ollamaApiKey: SYNTHETIC_OLLAMA_KEY }
      )
    )

    expect(await readLlmProviderAccess(path, "ollamaCloud")).toEqual({
      status: "configured",
      access: { provider: "ollamaCloud", apiKey: SYNTHETIC_OLLAMA_KEY }
    })
  })

  it.each([
    ["Ollama Cloud", "ollamaCloud"],
    ["Groq", "groq"]
  ] as const)(
    "reads %s on without a key as a missing key",
    async (_label, provider) => {
      const withoutKey = await writeSettingsFile(
        buildSettingsText({ enabled: [provider] }, {})
      )
      const nullKey = await writeSettingsFile(
        buildSettingsText(
          { enabled: [provider] },
          { ollamaApiKey: null, groqApiKey: null }
        )
      )

      expect(await readLlmProviderAccess(withoutKey, provider)).toEqual({
        status: "missing-key",
        provider
      })
      expect(await readLlmProviderAccess(nullKey, provider)).toEqual({
        status: "missing-key",
        provider
      })
    }
  )

  it("reads a provider without its key as off while it is not on", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({ enabled: ["lmStudio"] }, {})
    )

    expect(await readLlmProviderAccess(path, "groq")).toEqual({
      status: "off"
    })
  })

  it("reads one provider without regard to another provider's malformed key", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        { enabled: ["ollamaCloud", "groq"] },
        { ollamaApiKey: SYNTHETIC_OLLAMA_KEY, groqApiKey: "gsk key" }
      )
    )

    expect(await readLlmProviderAccess(path, "ollamaCloud")).toEqual({
      status: "configured",
      access: { provider: "ollamaCloud", apiKey: SYNTHETIC_OLLAMA_KEY }
    })
    expect(await readLlmProviderAccess(path, "groq")).toEqual({
      status: "unreadable"
    })
  })

  it.each([
    ["text that is not JSON", "{ not json"],
    ["a JSON array", "[]"],
    ["an unknown legacy provider", '{ "providers": { "active": "openai" } }'],
    [
      "an unknown legacy provider beside an enabled list",
      '{ "providers": { "enabled": ["groq"], "active": "openai" } }'
    ],
    [
      "a null legacy provider beside an enabled list",
      '{ "providers": { "enabled": ["lmStudio"], "active": null } }'
    ],
    ["a null enabled list", '{ "providers": { "enabled": null } }'],
    [
      "a field the providers group does not have",
      '{ "providers": { "enabled": ["lmStudio"], "openai": {} } }'
    ],
    [
      "an unknown provider in the enabled list",
      '{ "providers": { "enabled": ["lmStudio", "openai"] } }'
    ],
    [
      "a provider listed twice",
      '{ "providers": { "enabled": ["lmStudio", "lmStudio"] } }'
    ],
    [
      "an enabled value that is not a list",
      '{ "providers": { "enabled": "lmStudio" } }'
    ],
    [
      "an address with a scheme",
      '{ "providers": { "lmStudio": { "address": "http://127.0.0.1:1234" } } }'
    ]
  ])("reads %s as unreadable for every provider", async (_label, text) => {
    const path = await writeSettingsFile(text)

    expect(await readEveryProviderStatus(path)).toEqual({
      lmStudio: "unreadable",
      ollama: "unreadable",
      ollamaCloud: "unreadable",
      groq: "unreadable"
    })
  })

  it("reads Groq on with a key that breaks the key rule as unreadable", async () => {
    const path = await writeSettingsFile(
      '{ "providers": { "enabled": ["groq"] }, "secrets": { "groqApiKey": "gsk key" } }'
    )

    expect(await readLlmProviderAccess(path, "groq")).toEqual({
      status: "unreadable"
    })
  })
})

describe("findLlmProviderAccess", () => {
  it("finds the access of a provider that is on", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        { enabled: ["lmStudio", "groq"] },
        { groqApiKey: SYNTHETIC_GROQ_KEY }
      )
    )

    expect(await findLlmProviderAccess(path, "groq")).toEqual({
      provider: "groq",
      apiKey: SYNTHETIC_GROQ_KEY
    })
  })

  it("finds nothing for a provider that is off", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(
        { enabled: ["lmStudio"] },
        { groqApiKey: SYNTHETIC_GROQ_KEY }
      )
    )

    expect(await findLlmProviderAccess(path, "groq")).toBeUndefined()
  })

  it("rejects a provider that is on without its key, naming only the provider", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({ enabled: ["groq"] }, {})
    )

    await expect(findLlmProviderAccess(path, "groq")).rejects.toMatchObject({
      message: "The model provider is on but has no saved API key.",
      cause: { message: "No API key is saved for groq." }
    })
  })

  it("rejects an unreadable file without quoting it", async () => {
    const path = await writeSettingsFile(
      `{ "secrets": { "groqApiKey": "${SYNTHETIC_GROQ_KEY}" `
    )

    const failure = await findLlmProviderAccess(path, "groq").catch(
      (error: unknown) => error
    )

    expect(failure).toEqual(new Error("The settings file could not be read."))
    expect(failure).not.toHaveProperty("cause")
  })
})
