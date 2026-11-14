import {
  llmProviderSettingsSchema,
  modelLoadConfigurationSchema
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  loadSettings,
  saveEmailAccountSettings,
  saveGenerationSettings,
  saveLoadConfigurationSettings,
  saveLocationSettings,
  saveMcpSettings,
  saveProviderSettings,
  saveRuntimeAutoStartSettings,
  saveSecretsSettings,
  saveToolSettings
} from "@/lib/apis/tauri/settings"
import type { LoadConfigurationSettings } from "@/lib/store/settings"
import {
  NO_NATIVE_COMMAND_ARGS,
  startNativeHostFake
} from "../../../support/nativeHostFake"
import {
  createControlledPromise,
  createSettlementReader,
  waitForMicrotasks
} from "../../../support/settlement"
import {
  STORED_EMAIL_ACCOUNT,
  STORED_EMAIL_PASSWORD,
  STORED_GROQ_API_KEY,
  STORED_MCP_SETTINGS,
  STORED_PROVIDERS_SETTINGS,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT,
  STORED_TAVILY_API_KEY,
  type SettingsDocument
} from "../../../support/settingsFixtures"

/** Secrets group of the stored document without the email password. */
const NO_EMAIL_PASSWORD = Object.freeze({
  ...STORED_SETTINGS_DOCUMENT.secrets,
  emailPassword: null
})

/** Email group of a settings file that saves no account. */
const NO_EMAIL_ACCOUNT = Object.freeze({ account: null })

/** Load settings of the model whose key names an object-prototype member. */
const PROTOTYPE_KEY_LOAD_CONFIGURATION = modelLoadConfigurationSchema.parse({
  contextLength: 4096
})

/**
 * Settings document in which the one model with settings of its own and the
 * one switched tool both have the key `__proto__`, a valid tool name.
 *
 * @remarks The computed key makes `__proto__` a property of the object's own,
 * as parsing the host's JSON answer does; a literal `__proto__` key would set
 * the object's prototype instead.
 */
const PROTOTYPE_KEY_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  ...STORED_SETTINGS_DOCUMENT,
  loadConfiguration: Object.freeze({
    default: STORED_SETTINGS_DOCUMENT.loadConfiguration.default,
    models: Object.freeze({
      ["__proto__"]: PROTOTYPE_KEY_LOAD_CONFIGURATION
    })
  }),
  tools: Object.freeze({
    justRun: STORED_SETTINGS_DOCUMENT.tools.justRun,
    switches: Object.freeze({ ["__proto__"]: false })
  })
})

/** Load settings a mixture-of-experts model has of its own after an edit. */
const EDITED_MODEL_LOAD_CONFIGURATION = modelLoadConfigurationSchema.parse({
  numExperts: 4
})

/**
 * Load settings the store holds after the Models pane edited them: only
 * `qwen3-30b-a3b` has settings of its own, and the store's copy of the stored
 * default, read at startup, predates a hand edit of the file.
 */
const EDITED_LOAD_CONFIGURATION: LoadConfigurationSettings = Object.freeze({
  default: modelLoadConfigurationSchema.parse({}),
  models: new Map([["qwen3-30b-a3b", EDITED_MODEL_LOAD_CONFIGURATION]])
})

describe("loadSettings", () => {
  it("resolves with the loaded document's settings, the per-model load settings as a map keyed by model key", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT
    })

    await expect(loadSettings()).resolves.toEqual(STORED_SETTINGS)
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("keeps a model key and a switched tool's name that name an object-prototype member", async () => {
    startNativeHostFake({
      load_settings: () => PROTOTYPE_KEY_SETTINGS_DOCUMENT
    })

    const settings = await loadSettings()

    expect(settings.loadConfiguration.models).toEqual(
      new Map([["__proto__", PROTOTYPE_KEY_LOAD_CONFIGURATION]])
    )
    expect(settings.tools.switches).toEqual(new Map([["__proto__", false]]))
  })

  it("reads a settings file without a saved key as no key", async () => {
    /** Secrets group of a settings file that saves no key and no password. */
    const noSavedKeys = Object.freeze({
      tavilyApiKey: null,
      ollamaApiKey: null,
      groqApiKey: null,
      emailPassword: null
    })

    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        secrets: noSavedKeys
      })
    })

    const settings = await loadSettings()

    expect(settings.secrets).toEqual(noSavedKeys)
  })

  it.each([
    ["tavilyApiKey", "Tavily"],
    ["ollamaApiKey", "Ollama"],
    ["groqApiKey", "Groq"]
  ])(
    "rejects a %s that fails the key format without naming the key",
    async (field, serviceName) => {
      const spacedKey = "key with-a-space"
      startNativeHostFake({
        load_settings: () => ({
          ...STORED_SETTINGS_DOCUMENT,
          secrets: { ...STORED_SETTINGS_DOCUMENT.secrets, [field]: spacedKey }
        })
      })

      const failure = await loadSettings().then(
        () => {
          throw new Error("The settings loaded")
        },
        (rejection: unknown) => rejection
      )

      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({
        message: `The settings file holds an invalid ${serviceName} API key.`
      })
      expect(String(failure)).not.toContain(spacedKey)
    }
  )

  it("reads the stored default model's key on the first provider that is on, in provider order", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        providers: { ...STORED_PROVIDERS_SETTINGS, enabled: ["groq", "ollama"] }
      })
    })

    const settings = await loadSettings()

    expect(settings.runtime.defaultModel).toEqual({
      provider: "ollama",
      modelKey: "qwen3-8b"
    })
  })

  it("reads the stored default model's key as no model while no provider is on", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        providers: { ...STORED_PROVIDERS_SETTINGS, enabled: [] }
      })
    })

    const settings = await loadSettings()

    expect(settings.runtime.defaultModel).toBeNull()
  })

  it("reads a settings file without a default model as no model", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        runtime: { ...STORED_SETTINGS_DOCUMENT.runtime, defaultModel: null }
      })
    })

    const settings = await loadSettings()

    expect(settings.runtime.defaultModel).toBeNull()
  })

  it("reads an empty stored default model's key as no model while a provider is on", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        providers: { ...STORED_PROVIDERS_SETTINGS, enabled: ["lmStudio"] },
        runtime: { ...STORED_SETTINGS_DOCUMENT.runtime, defaultModel: "" }
      })
    })

    const settings = await loadSettings()

    expect(settings.runtime.defaultModel).toBeNull()
  })

  it("reads the providers that are on with their addresses", async () => {
    startNativeHostFake({ load_settings: () => STORED_SETTINGS_DOCUMENT })

    const settings = await loadSettings()

    expect(settings.providers).toEqual(STORED_PROVIDERS_SETTINGS)
  })

  it("rejects a providers group that fails the provider rules", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        providers: { ...STORED_PROVIDERS_SETTINGS, enabled: ["openai"] }
      })
    })

    await expect(loadSettings()).rejects.toThrow(
      "The settings file holds an invalid provider choice."
    )
  })

  it("reads a settings file without a saved location as no location", async () => {
    const noLocation = { city: null, region: null, country: null }
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        location: noLocation
      })
    })

    const settings = await loadSettings()

    expect(settings.location).toEqual(noLocation)
  })

  it("rejects a place name that fails the name rule without naming the place", async () => {
    const paddedCity = " Villeurbanne"
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        location: { city: paddedCity, region: null, country: "France" }
      })
    })

    const failure = await loadSettings().then(
      () => {
        throw new Error("The settings loaded")
      },
      (rejection: unknown) => rejection
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "The settings file holds an invalid location."
    })
    expect(String(failure)).not.toContain("Villeurbanne")
  })

  it("reads an empty Just run list and an empty switches object as no tool on Just run and no tool switched", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        tools: { justRun: [], switches: {} }
      })
    })

    const settings = await loadSettings()

    expect(settings.tools).toEqual({
      approvedFolderPaths: [],
      justRunToolNames: new Set(),
      switches: new Map()
    })
  })

  it("reads the approved folders as a frozen list in the stored order", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        tools: {
          justRun: [],
          switches: {},
          approvedFolders: ["/Users/ada/work", "/srv/shared"]
        }
      })
    })

    const { approvedFolderPaths } = (await loadSettings()).tools

    expect(approvedFolderPaths).toEqual(["/Users/ada/work", "/srv/shared"])
    expect(Object.isFrozen(approvedFolderPaths)).toBe(true)
  })

  it("reads a server's omitted lists as empty, an omitted switch as on, omitted built-in switches as off, and freezes the servers", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        mcp: {
          servers: [
            { name: "files", transport: "stdio", command: "/usr/bin/files" },
            {
              name: "notes",
              transport: "http",
              url: "http://127.0.0.1:9000",
              enabled: false
            }
          ]
        }
      })
    })

    const settings = await loadSettings()

    expect(settings.mcp).toEqual({
      servers: [
        {
          name: "files",
          transport: "stdio",
          enabled: true,
          command: "/usr/bin/files",
          arguments: [],
          environment: []
        },
        {
          name: "notes",
          transport: "http",
          enabled: false,
          url: "http://127.0.0.1:9000",
          headers: []
        }
      ],
      builtIn: { email: { enabled: false } }
    })
    expect(Object.isFrozen(settings.mcp.servers)).toBe(true)
    expect(Object.isFrozen(settings.mcp.servers[0])).toBe(true)
  })

  it("reads the built-in servers' switches", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        mcp: { servers: [], builtIn: { email: { enabled: true } } }
      })
    })

    const settings = await loadSettings()

    expect(settings.mcp).toEqual({
      servers: [],
      builtIn: { email: { enabled: true } }
    })
  })

  it("rejects MCP servers that fail the shared rules without naming a header value", async () => {
    const headerValue = "Bearer leaked token "
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        mcp: {
          servers: [
            {
              name: "notes",
              transport: "http",
              url: "https://mcp.example.test/notes",
              headers: [{ name: "Authorization", value: headerValue }]
            }
          ]
        }
      })
    })

    const failure = await loadSettings().then(
      () => {
        throw new Error("The settings loaded")
      },
      (rejection: unknown) => rejection
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "The settings file holds invalid MCP server settings."
    })
    expect(String(failure)).not.toContain("leaked")
  })

  it("reads the saved email account and its password, the password branded", async () => {
    startNativeHostFake({ load_settings: () => STORED_SETTINGS_DOCUMENT })

    const settings = await loadSettings()

    expect(settings.email).toEqual({ account: STORED_EMAIL_ACCOUNT })
    expect(Object.isFrozen(settings.email.account)).toBe(true)
    expect(settings.secrets.emailPassword).toBe(STORED_EMAIL_PASSWORD)
  })

  it("reads a settings file without an email account as no account", async () => {
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        secrets: NO_EMAIL_PASSWORD,
        email: NO_EMAIL_ACCOUNT
      })
    })

    const settings = await loadSettings()

    expect(settings.email).toEqual({ account: null })
    expect(settings.secrets.emailPassword).toBeNull()
  })

  it("rejects an email account that fails the shared rules without naming the address", async () => {
    const address = "leaked-address@example.test"
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        email: {
          account: {
            ...STORED_EMAIL_ACCOUNT,
            address,
            imap: { host: "imap.example.test", port: 143, security: "plain" }
          }
        }
      })
    })

    const failure = await loadSettings().then(
      () => {
        throw new Error("The settings loaded")
      },
      (rejection: unknown) => rejection
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "The settings file holds an invalid email account."
    })
    expect(String(failure)).not.toContain("leaked")
  })

  it("rejects an email password that fails the password rule without printing it", async () => {
    const brokenPassword = "leaked\npassword"
    startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        secrets: {
          ...STORED_SETTINGS_DOCUMENT.secrets,
          emailPassword: brokenPassword
        }
      })
    })

    const failure = await loadSettings().then(
      () => {
        throw new Error("The settings loaded")
      },
      (rejection: unknown) => rejection
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "The settings file holds an invalid email password."
    })
    expect(String(failure)).not.toContain("leaked")
  })

  it("rejects with the host's rejection", async () => {
    startNativeHostFake({
      load_settings: () => Promise.reject("Failed to parse settings.json")
    })

    await expect(loadSettings()).rejects.toBe("Failed to parse settings.json")
  })
})

describe("saveGenerationSettings", () => {
  it("replaces only the generation group of the document on disk", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveGenerationSettings({ temperature: 0.9, replyCeiling: 0 })

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            generation: { temperature: 0.9, replyCeiling: 0 }
          }
        }
      }
    ])
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(
      saveGenerationSettings({ temperature: 0.9, replyCeiling: 0 })
    ).rejects.toBe("Failed to read settings.json")
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("resolves only after the host finishes writing", async () => {
    const write = createControlledPromise<null>()
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => write.promise
    })

    const getSettlement = createSettlementReader(
      saveGenerationSettings({ temperature: 0.9, replyCeiling: 0 })
    )
    await waitForMicrotasks()
    const beforeWrite = getSettlement()
    write.resolve(null)
    await waitForMicrotasks()

    expect([beforeWrite, getSettlement()]).toEqual(["pending", "fulfilled"])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(
      saveGenerationSettings({ temperature: 0.9, replyCeiling: 0 })
    ).rejects.toBe("Disk full")
  })
})

describe("saveLoadConfigurationSettings", () => {
  it("replaces only the per-model load settings of the document on disk, keeping its stored default", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveLoadConfigurationSettings(EDITED_LOAD_CONFIGURATION)

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            loadConfiguration: {
              default: STORED_SETTINGS_DOCUMENT.loadConfiguration.default,
              models: { "qwen3-30b-a3b": EDITED_MODEL_LOAD_CONFIGURATION }
            }
          }
        }
      }
    ])
  })

  it("writes a model key that names an object-prototype member as a property of its own", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveLoadConfigurationSettings({
      default: STORED_SETTINGS.loadConfiguration.default,
      models: new Map([["__proto__", PROTOTYPE_KEY_LOAD_CONFIGURATION]])
    })

    expect(host.commands[1]).toEqual({
      command: "save_settings",
      args: {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          loadConfiguration: PROTOTYPE_KEY_SETTINGS_DOCUMENT.loadConfiguration
        }
      }
    })
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(
      saveLoadConfigurationSettings(EDITED_LOAD_CONFIGURATION)
    ).rejects.toBe("Failed to read settings.json")
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(
      saveLoadConfigurationSettings(EDITED_LOAD_CONFIGURATION)
    ).rejects.toBe("Disk full")
  })
})

describe("saveSecretsSettings", () => {
  it("replaces only the given key of the document on disk", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveSecretsSettings({ tavilyApiKey: null })

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            secrets: {
              tavilyApiKey: null,
              ollamaApiKey: null,
              groqApiKey: STORED_GROQ_API_KEY,
              emailPassword: STORED_EMAIL_PASSWORD
            }
          }
        }
      }
    ])
  })

  it("writes a new key as the document's plain-text key", async () => {
    const host = startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        secrets: { ...STORED_SETTINGS_DOCUMENT.secrets, tavilyApiKey: null }
      }),
      save_settings: () => null
    })

    await saveSecretsSettings({ tavilyApiKey: STORED_TAVILY_API_KEY })

    expect(host.commands[1]).toEqual({
      command: "save_settings",
      args: { newSettings: STORED_SETTINGS_DOCUMENT }
    })
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(saveSecretsSettings({ tavilyApiKey: null })).rejects.toBe(
      "Failed to read settings.json"
    )
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(saveSecretsSettings({ tavilyApiKey: null })).rejects.toBe(
      "Disk full"
    )
  })
})

describe("saveProviderSettings", () => {
  it("replaces only the providers group of the document on disk", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })
    const providers = llmProviderSettingsSchema.parse({
      enabled: ["lmStudio", "ollamaCloud"],
      lmStudio: { address: "10.0.0.5:1234" },
      ollama: { address: null }
    })

    await saveProviderSettings(providers)

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: { newSettings: { ...STORED_SETTINGS_DOCUMENT, providers } }
      }
    ])
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(saveProviderSettings(STORED_PROVIDERS_SETTINGS)).rejects.toBe(
      "Failed to read settings.json"
    )
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })
})

describe("saveLocationSettings", () => {
  it("replaces only the location group of the document on disk", async () => {
    const noLocation = { city: null, region: null, country: null }
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveLocationSettings(noLocation)

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: { ...STORED_SETTINGS_DOCUMENT, location: noLocation }
        }
      }
    ])
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(saveLocationSettings(STORED_SETTINGS.location)).rejects.toBe(
      "Failed to read settings.json"
    )
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(saveLocationSettings(STORED_SETTINGS.location)).rejects.toBe(
      "Disk full"
    )
  })
})

describe("saveMcpSettings", () => {
  it("replaces only the mcp group of the document on disk", async () => {
    const onlyNotes = {
      ...STORED_MCP_SETTINGS,
      servers: [STORED_MCP_SETTINGS.servers[1]]
    }
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveMcpSettings(onlyNotes)

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: { ...STORED_SETTINGS_DOCUMENT, mcp: onlyNotes }
        }
      }
    ])
  })

  it("writes an empty server list when every server was removed, keeping the built-in switches", async () => {
    const noServers = { ...STORED_MCP_SETTINGS, servers: [] }
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveMcpSettings(noServers)

    expect(host.commands.at(-1)).toEqual({
      command: "save_settings",
      args: {
        newSettings: { ...STORED_SETTINGS_DOCUMENT, mcp: noServers }
      }
    })
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(saveMcpSettings(STORED_MCP_SETTINGS)).rejects.toBe(
      "Failed to read settings.json"
    )
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(saveMcpSettings(STORED_MCP_SETTINGS)).rejects.toBe("Disk full")
  })
})

describe("saveEmailAccountSettings", () => {
  const editedAccount = {
    ...STORED_EMAIL_ACCOUNT,
    displayName: "Ada Edited"
  }

  it("replaces the email account and its password together, in one write", async () => {
    const host = startNativeHostFake({
      load_settings: () => ({
        ...STORED_SETTINGS_DOCUMENT,
        secrets: NO_EMAIL_PASSWORD,
        email: NO_EMAIL_ACCOUNT
      }),
      save_settings: () => null
    })

    await saveEmailAccountSettings(editedAccount, STORED_EMAIL_PASSWORD)

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            email: { account: editedAccount }
          }
        }
      }
    ])
  })

  it("removes the account and the password together", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveEmailAccountSettings(null, null)

    expect(host.commands.at(-1)).toEqual({
      command: "save_settings",
      args: {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          secrets: NO_EMAIL_PASSWORD,
          email: NO_EMAIL_ACCOUNT
        }
      }
    })
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(
      saveEmailAccountSettings(editedAccount, STORED_EMAIL_PASSWORD)
    ).rejects.toBe("Failed to read settings.json")
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(
      saveEmailAccountSettings(editedAccount, STORED_EMAIL_PASSWORD)
    ).rejects.toBe("Disk full")
  })
})

describe("saveToolSettings", () => {
  it("replaces only the tools group of the document on disk", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveToolSettings({
      approvedFolderPaths: [],
      justRunToolNames: new Set(["read_text_file", "find_files"]),
      switches: new Map([
        ["web_search", true],
        ["find_files", false]
      ])
    })

    expect(host.commands).toEqual([
      { command: "load_settings", args: {} },
      {
        command: "save_settings",
        args: {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            tools: {
              justRun: ["read_text_file", "find_files"],
              switches: { web_search: true, find_files: false }
            }
          }
        }
      }
    ])
  })

  it("writes an empty list and an empty object when no tool is on Just run or switched, and no folder list when none is listed", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveToolSettings({
      approvedFolderPaths: [],
      justRunToolNames: new Set(),
      switches: new Map()
    })

    expect(host.commands[1]).toEqual({
      command: "save_settings",
      args: {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          tools: { justRun: [], switches: {} }
        }
      }
    })
  })

  it("writes a switched tool's name that names an object-prototype member as a property of its own", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveToolSettings({
      approvedFolderPaths: [],
      justRunToolNames: STORED_SETTINGS.tools.justRunToolNames,
      switches: new Map([["__proto__", false]])
    })

    expect(host.commands[1]).toEqual({
      command: "save_settings",
      args: {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          tools: PROTOTYPE_KEY_SETTINGS_DOCUMENT.tools
        }
      }
    })
  })

  it("writes the approved folders in the list's order", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveToolSettings({
      approvedFolderPaths: ["/srv/shared", "/Users/ada/work"],
      justRunToolNames: new Set(),
      switches: new Map()
    })

    expect(host.commands[1]).toEqual({
      command: "save_settings",
      args: {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          tools: {
            justRun: [],
            switches: {},
            approvedFolders: ["/srv/shared", "/Users/ada/work"]
          }
        }
      }
    })
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(
      saveToolSettings({
        approvedFolderPaths: [],
        justRunToolNames: new Set(["find_files"]),
        switches: new Map()
      })
    ).rejects.toBe("Failed to read settings.json")
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(
      saveToolSettings({
        approvedFolderPaths: [],
        justRunToolNames: new Set(["find_files"]),
        switches: new Map()
      })
    ).rejects.toBe("Disk full")
  })
})

describe("saveRuntimeAutoStartSettings", () => {
  it("replaces only the two startup switches, keeping the default model and backend address on disk", async () => {
    const host = startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => null
    })

    await saveRuntimeAutoStartSettings({
      autoStartBackend: true,
      autoStartVmo: true
    })

    const savedRuntime: SettingsDocument["runtime"] = {
      autoStartBackend: true,
      autoStartVmo: true,
      defaultModel: STORED_SETTINGS_DOCUMENT.runtime.defaultModel,
      backendAddress: STORED_SETTINGS_DOCUMENT.runtime.backendAddress
    }
    const newSettings: SettingsDocument = {
      ...STORED_SETTINGS_DOCUMENT,
      runtime: savedRuntime
    }
    const saveSettingsArgs = { newSettings }
    expect(host.commands).toEqual([
      { command: "load_settings", args: NO_NATIVE_COMMAND_ARGS },
      { command: "save_settings", args: saveSettingsArgs }
    ])
  })

  it("keeps the stored default model's key while no provider is on, though the renderer reads no default model then", async () => {
    const noProviderOn: SettingsDocument = {
      ...STORED_SETTINGS_DOCUMENT,
      providers: { ...STORED_PROVIDERS_SETTINGS, enabled: [] }
    }
    const host = startNativeHostFake({
      load_settings: () => noProviderOn,
      save_settings: () => null
    })

    await saveRuntimeAutoStartSettings({
      autoStartBackend: true,
      autoStartVmo: false
    })

    expect(host.commands[1]).toEqual({
      command: "save_settings",
      args: {
        newSettings: {
          ...noProviderOn,
          runtime: {
            ...STORED_SETTINGS_DOCUMENT.runtime,
            autoStartBackend: true,
            autoStartVmo: false
          }
        }
      }
    })
  })

  it("writes nothing when the document cannot be loaded", async () => {
    const host = startNativeHostFake({
      load_settings: () => Promise.reject("Failed to read settings.json"),
      save_settings: () => null
    })

    await expect(
      saveRuntimeAutoStartSettings({
        autoStartBackend: true,
        autoStartVmo: false
      })
    ).rejects.toBe("Failed to read settings.json")
    expect(host.commands.map((invoked) => invoked.command)).toEqual([
      "load_settings"
    ])
  })

  it("rejects when the merged document cannot be written", async () => {
    startNativeHostFake({
      load_settings: () => STORED_SETTINGS_DOCUMENT,
      save_settings: () => Promise.reject("Disk full")
    })

    await expect(
      saveRuntimeAutoStartSettings({
        autoStartBackend: true,
        autoStartVmo: false
      })
    ).rejects.toBe("Disk full")
  })
})
