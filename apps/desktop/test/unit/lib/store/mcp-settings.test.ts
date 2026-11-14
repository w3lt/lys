import {
  MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH,
  MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT,
  mcpServerSettingsSchema,
  type McpServerSettings
} from "@lys/share"
import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"
import {
  createMcpSettingsSlice,
  type McpSettingsSlice
} from "@/lib/store/mcp-settings"
import type { LysSettings } from "@/lib/store/settings"
import { createSettingsGroupSaves } from "@/lib/store/settings-group-saves"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks,
  type ControlledPromise
} from "../../support/settlement"
import {
  EMAIL_ON_SETTINGS,
  LYS_MAILBOX_ON_SETTINGS,
  STORED_MCP_SETTINGS,
  STORED_SETTINGS,
  STORED_SETTINGS_DOCUMENT
} from "../../support/settingsFixtures"

/** Store state the slice borrows: the current settings and the slice. */
type McpStore = McpSettingsSlice & { settings: LysSettings }

/** Server the person adds after the stored ones. */
const ADDED_SERVER = mcpServerSettingsSchema.parse({
  name: "calendar",
  transport: "http",
  url: "http://localhost:7000/mcp"
})

/** Server list with the added server after the stored ones. */
const SERVERS_WITH_ADDED = Object.freeze([
  ...STORED_MCP_SETTINGS.servers,
  ADDED_SERVER
])

/**
 * Builds a command server whose variables all reach the shared length limit.
 *
 * @param name - Server name.
 * @returns A server the shared server rules accept, about 130 KiB as JSON.
 */
function buildServerWithLongestVariables(name: string): McpServerSettings {
  const environment = Array.from(
    { length: MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT },
    (_, index) => ({
      name: `VARIABLE_${index}`,
      value: "v".repeat(MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH)
    })
  )
  return mcpServerSettingsSchema.parse({
    name,
    transport: "stdio",
    command: "node",
    environment
  })
}

/**
 * Servers that each pass the shared server rules but together take more
 * than the 512 KiB the `mcp` group may take of the settings file.
 */
const SERVERS_PAST_GROUP_LIMIT = Object.freeze(
  ["one", "two", "three", "four", "five"].map(buildServerWithLongestVariables)
)

/**
 * Creates a store holding settings with two saved servers.
 *
 * @param settings - Settings the store starts with; the stored settings,
 * which save the person's account and no account of Lys's, by default.
 * @returns A store owning one MCP settings slice, whose saves run through
 * the application's settings-group saves over the native host.
 */
function createMcpStore(settings: LysSettings = STORED_SETTINGS) {
  const settingsGroupSaves = createSettingsGroupSaves()
  return createStore<McpStore>()((set, get) => ({
    settings,
    ...createMcpSettingsSlice(set, get, {
      saveMcpSettings: settingsGroupSaves.saveMcpSettings
    })
  }))
}

/**
 * Starts a native host that loads the stored settings document and whose
 * settings writes stay pending until the case settles them, one controlled
 * promise per write.
 *
 * @returns The host observation handle and the pending writes in order.
 */
function startControlledSettingsHost() {
  const writes: ControlledPromise<null>[] = []
  const host = startNativeHostFake({
    load_settings: () => STORED_SETTINGS_DOCUMENT,
    save_settings: () => {
      const write = createControlledPromise<null>()
      writes.push(write)
      return write.promise
    }
  })
  return { host, writes }
}

/**
 * Lists the arguments of every settings write, in order.
 *
 * @param commands - Native commands the host observed.
 * @returns The arguments each `save_settings` call carried.
 */
function listSettingsWrites(
  commands: readonly { command: string; args: unknown }[]
): unknown[] {
  return commands
    .filter((invoked) => invoked.command === "save_settings")
    .map((invoked) => invoked.args)
}

describe("createMcpSettingsSlice", () => {
  it("starts with no save", () => {
    const store = createMcpStore()

    expect(store.getState().mcpSettingsSave).toEqual({ status: "idle" })
  })

  it("reports saving until the write completes, then holds the new list, keeping the other groups on disk", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createMcpStore()

    const save = store.getState().saveMcpServers(SERVERS_WITH_ADDED)
    await waitForMicrotasks()
    const whileWriting = store.getState()
    writes[0]?.resolve(null)

    await expect(save).resolves.toBe("saved")
    expect(whileWriting.mcpSettingsSave).toEqual({ status: "saving" })
    expect(whileWriting.settings.mcp).toEqual(STORED_MCP_SETTINGS)
    expect(store.getState().mcpSettingsSave).toEqual({ status: "saved" })
    expect(store.getState().settings.mcp).toEqual({
      ...STORED_MCP_SETTINGS,
      servers: SERVERS_WITH_ADDED
    })
    expect(Object.isFrozen(store.getState().settings.mcp.servers)).toBe(true)
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          mcp: { ...STORED_MCP_SETTINGS, servers: SERVERS_WITH_ADDED }
        }
      }
    ])
  })

  it("keeps its own copy of the list it was given", async () => {
    const { writes } = startControlledSettingsHost()
    const store = createMcpStore()
    const servers = [ADDED_SERVER]

    const save = store.getState().saveMcpServers(servers)
    servers.push(STORED_MCP_SETTINGS.servers[0])
    await waitForMicrotasks()
    writes[0]?.resolve(null)
    await save

    expect(store.getState().settings.mcp).toEqual({
      ...STORED_MCP_SETTINGS,
      servers: [ADDED_SERVER]
    })
  })

  it("keeps the saved servers and reports a failed save without the host's detail", async () => {
    const { writes } = startControlledSettingsHost()
    const store = createMcpStore()

    const save = store.getState().saveMcpServers([])
    await waitForMicrotasks()
    writes[0]?.reject("EACCES: /Users/someone/.lys/settings.json")

    await expect(save).resolves.toBe("failed")
    expect(store.getState().mcpSettingsSave).toEqual({
      status: "failed",
      error: "Lys couldn't write the MCP servers to its settings file."
    })
    expect(store.getState().settings.mcp).toEqual(STORED_MCP_SETTINGS)
  })

  it("refuses servers that take more than the group's share of the settings file, naming the limit, without writing", async () => {
    const { host } = startControlledSettingsHost()
    const store = createMcpStore()

    const outcome = await store
      .getState()
      .saveMcpServers(SERVERS_PAST_GROUP_LIMIT)

    expect(outcome).toBe("failed")
    expect(store.getState().mcpSettingsSave).toEqual({
      status: "failed",
      error: "The MCP servers take at most 512 KiB of settings together."
    })
    expect(listSettingsWrites(host.commands)).toEqual([])
    expect(store.getState().settings.mcp).toEqual(STORED_MCP_SETTINGS)
  })

  it("answers busy without writing while another save runs", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createMcpStore()

    const first = store.getState().saveMcpServers(SERVERS_WITH_ADDED)
    await waitForMicrotasks()
    const second = await store.getState().saveMcpServers([])
    writes[0]?.resolve(null)
    await first

    expect(second).toBe("busy")
    expect(listSettingsWrites(host.commands)).toHaveLength(1)
    expect(store.getState().settings.mcp).toEqual({
      ...STORED_MCP_SETTINGS,
      servers: SERVERS_WITH_ADDED
    })
  })

  it("saves again after a failed save", async () => {
    const { writes } = startControlledSettingsHost()
    const store = createMcpStore()

    const failed = store.getState().saveMcpServers([])
    await waitForMicrotasks()
    writes[0]?.reject("Disk full")
    await failed
    const retry = store.getState().saveMcpServers([])
    await waitForMicrotasks()
    writes[1]?.resolve(null)

    await expect(retry).resolves.toBe("saved")
    expect(store.getState().settings.mcp).toEqual({
      ...STORED_MCP_SETTINGS,
      servers: []
    })
  })

  it("keeps the built-in switches as saved when the added servers are saved", async () => {
    const { host, writes } = startControlledSettingsHost()
    const store = createMcpStore()
    store.setState({ settings: EMAIL_ON_SETTINGS })

    const save = store.getState().saveMcpServers([ADDED_SERVER])
    await waitForMicrotasks()
    writes[0]?.resolve(null)
    await save

    expect(store.getState().settings.mcp).toEqual({
      servers: [ADDED_SERVER],
      builtIn: { email: { enabled: true, lysEnabled: false } }
    })
    expect(listSettingsWrites(host.commands)).toEqual([
      {
        newSettings: {
          ...STORED_SETTINGS_DOCUMENT,
          mcp: {
            servers: [ADDED_SERVER],
            builtIn: { email: { enabled: true, lysEnabled: false } }
          }
        }
      }
    ])
  })

  describe("saveBuiltInMcpServerSwitch", () => {
    it("saves the switch of a server Lys ships, keeping the added servers", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createMcpStore()

      const save = store.getState().saveBuiltInMcpServerSwitch("email", true)
      await waitForMicrotasks()
      const whileWriting = store.getState()
      writes[0]?.resolve(null)

      await expect(save).resolves.toBe("saved")
      expect(whileWriting.mcpSettingsSave).toEqual({ status: "saving" })
      expect(whileWriting.settings.mcp).toEqual(STORED_MCP_SETTINGS)
      expect(store.getState().settings.mcp).toEqual({
        servers: STORED_MCP_SETTINGS.servers,
        builtIn: { email: { enabled: true, lysEnabled: false } }
      })
      expect(listSettingsWrites(host.commands)).toEqual([
        {
          newSettings: {
            ...STORED_SETTINGS_DOCUMENT,
            mcp: {
              servers: STORED_MCP_SETTINGS.servers,
              builtIn: { email: { enabled: true, lysEnabled: false } }
            }
          }
        }
      ])
    })

    it("keeps the saved switch and reports a failed save", async () => {
      const { writes } = startControlledSettingsHost()
      const store = createMcpStore()

      const save = store.getState().saveBuiltInMcpServerSwitch("email", true)
      await waitForMicrotasks()
      writes[0]?.reject("Disk full")

      await expect(save).resolves.toBe("failed")
      expect(store.getState().mcpSettingsSave).toEqual({
        status: "failed",
        error: "Lys couldn't write the MCP servers to its settings file."
      })
      expect(store.getState().settings.mcp).toEqual(STORED_MCP_SETTINGS)
    })

    it.each([
      {
        label: "on, with only the person's account saved",
        settings: STORED_SETTINGS,
        isOn: true,
        email: { enabled: true, lysEnabled: false }
      },
      {
        label: "on, with both accounts saved",
        settings: LYS_MAILBOX_ON_SETTINGS,
        isOn: true,
        email: { enabled: true, lysEnabled: true }
      },
      {
        label: "off",
        settings: LYS_MAILBOX_ON_SETTINGS,
        isOn: false,
        email: { enabled: false, lysEnabled: false }
      }
    ] as const)(
      "switches the email server $label, as each mailbox's switch",
      async ({ settings, isOn, email }) => {
        startNativeHostFake({
          load_settings: () => STORED_SETTINGS_DOCUMENT,
          save_settings: () => null
        })
        const store = createMcpStore(settings)

        await store.getState().saveBuiltInMcpServerSwitch("email", isOn)

        expect(store.getState().settings.mcp.builtIn.email).toEqual(email)
      }
    )

    it("answers busy without writing while a save of the added servers runs", async () => {
      const { host, writes } = startControlledSettingsHost()
      const store = createMcpStore()

      const first = store.getState().saveMcpServers(SERVERS_WITH_ADDED)
      await waitForMicrotasks()
      const second = await store
        .getState()
        .saveBuiltInMcpServerSwitch("email", true)
      writes[0]?.resolve(null)
      await first

      expect(second).toBe("busy")
      expect(listSettingsWrites(host.commands)).toHaveLength(1)
      expect(store.getState().settings.mcp.builtIn).toEqual(
        STORED_MCP_SETTINGS.builtIn
      )
    })
  })

  describe("saveEmailMailboxSwitch", () => {
    it("saves one mailbox's switch, keeping the other's and the added servers", async () => {
      const host = startNativeHostFake({
        load_settings: () => STORED_SETTINGS_DOCUMENT,
        save_settings: () => null
      })
      const store = createMcpStore(LYS_MAILBOX_ON_SETTINGS)

      await expect(
        store.getState().saveEmailMailboxSwitch("person", true)
      ).resolves.toBe("saved")
      const afterPersonOn = store.getState().settings.mcp.builtIn.email
      await store.getState().saveEmailMailboxSwitch("lys", false)

      expect(afterPersonOn).toEqual({ enabled: true, lysEnabled: true })
      expect(store.getState().settings.mcp).toEqual({
        servers: STORED_MCP_SETTINGS.servers,
        builtIn: { email: { enabled: true, lysEnabled: false } }
      })
      expect(listSettingsWrites(host.commands)).toHaveLength(2)
    })
  })
})
