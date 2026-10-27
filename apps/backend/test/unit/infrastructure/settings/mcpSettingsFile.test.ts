import { MAXIMUM_OFFERED_BACKEND_TOOL_COUNT } from "@lys/protocol"
import {
  MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT,
  MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH,
  MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT,
  MAXIMUM_MCP_SERVER_COUNT,
  MAXIMUM_MCP_SETTINGS_BYTES,
  MAXIMUM_SETTINGS_FILE_BYTES
} from "@lys/share"
import { readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { readMcpSettings } from "../../../../src/infrastructure/settings/mcpSettingsFile"
import {
  createSettingsFilePath,
  writeSettingsFile
} from "../../support/settingsFile"

/** Synthetic header value standing in for a secret; not a real credential. */
const SYNTHETIC_TOKEN = "Bearer synthetic-token-0123"

/** Synthetic variable value standing in for a secret; not a real credential. */
const SYNTHETIC_VARIABLE_VALUE = "synthetic-variable-4567"

/** One server of each transport, as the desktop writes them. */
const VALID_MCP_GROUP = Object.freeze({
  servers: [
    {
      name: "files",
      transport: "stdio",
      command: "npx",
      arguments: ["-y", "files-server"],
      environment: [{ name: "FILES_TOKEN", value: SYNTHETIC_VARIABLE_VALUE }]
    },
    {
      name: "remote-notes",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "Authorization", value: SYNTHETIC_TOKEN }]
    }
  ]
})

/**
 * Validates one case of the groups shared with the desktop host: an
 * accepted group comes with what the host writes back for it.
 */
const sharedMcpGroupCaseSchema = z.discriminatedUnion("accepted", [
  z.strictObject({
    case: z.string(),
    group: z.unknown(),
    accepted: z.literal(true),
    written: z.record(z.string(), z.unknown())
  }),
  z.strictObject({
    case: z.string(),
    group: z.unknown(),
    accepted: z.literal(false)
  })
])

/**
 * Groups that this reader and the desktop host must judge alike; the host's
 * tests in `src-tauri/src/settings/mcp.rs` read the same file.
 */
const SHARED_MCP_GROUP_CASES = z
  .array(sharedMcpGroupCaseSchema)
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../packages/share/test/fixtures/mcp-settings-groups.json",
          import.meta.url
        ),
        "utf8"
      )
    )
  )

/**
 * Builds settings file text holding every group the desktop writes.
 *
 * @param mcp - Value of the `mcp` group.
 * @returns The JSON text.
 */
function buildSettingsText(mcp: unknown): string {
  return JSON.stringify({
    runtime: { autoStartBackend: true, defaultModel: null },
    generation: { temperature: 0.7, replyCeiling: 2048 },
    secrets: { tavilyApiKey: "tvly-synthetic-0123456789" },
    futureGroup: { anything: [1, 2, 3] },
    mcp
  })
}

/**
 * Builds settings file text the way the desktop host writes it, indented by
 * two spaces with a final line break, with every group it writes. The other
 * groups are at their largest: the longest key and place names, and every
 * tool the backend can offer, each with a 64-character name, on Just run and
 * switched.
 *
 * @param mcp - Value of the `mcp` group.
 * @returns The JSON text.
 */
function buildLargestSettingsText(mcp: unknown): string {
  const toolNames = Array.from(
    { length: MAXIMUM_OFFERED_BACKEND_TOOL_COUNT },
    (_, index) => String(index).padStart(64, "t")
  )
  const settings = {
    runtime: {
      autoStartBackend: true,
      autoStartVmo: true,
      defaultModel: "qwen/qwen3-8b",
      backendAddress: "http://127.0.0.1:23456"
    },
    generation: { temperature: 0.7, replyCeiling: 2048 },
    loadConfiguration: { default: {}, models: {} },
    secrets: { tavilyApiKey: "tvly-synthetic-".padEnd(256, "0") },
    tools: {
      justRun: toolNames,
      switches: Object.fromEntries(toolNames.map((name) => [name, false]))
    },
    location: {
      city: "c".repeat(100),
      region: "r".repeat(100),
      country: "k".repeat(100)
    },
    mcp
  }
  return `${JSON.stringify(settings, null, 2)}\n`
}

/** One stdio server of {@link buildMcpGroupOfBytes}, with every list written. */
type FilledStdioServer = {
  /** Server name, distinct in the group. */
  name: string
  /** Always a stdio server. */
  transport: "stdio"
  /** Command of one character. */
  command: string
  /** The most arguments, each of one character. */
  arguments: string[]
  /** The most variables; the builder fills their values to size. */
  environment: { name: string; value: string }[]
}

/**
 * Builds an `mcp` group that takes exactly a number of bytes as compact
 * JSON: the most stdio servers, each with the most one-character arguments
 * and the most environment variables, whose values take the remaining bytes
 * in list order. Its many short entries make the host's indentation add as
 * much as a group of that size can get.
 *
 * @param bytes - UTF-8 bytes of the group's compact JSON; at least the bytes
 * of the group with empty values, at most those with full values.
 * @returns The group, which a new call builds anew.
 */
function buildMcpGroupOfBytes(bytes: number): { servers: FilledStdioServer[] } {
  const servers = Array.from(
    { length: MAXIMUM_MCP_SERVER_COUNT },
    (_, serverIndex): FilledStdioServer => ({
      name: `server-${serverIndex}`,
      transport: "stdio",
      command: "c",
      arguments: Array.from(
        { length: MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT },
        () => "a"
      ),
      environment: Array.from(
        { length: MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT },
        (_, variableIndex) => ({ name: `V${variableIndex}`, value: "" })
      )
    })
  )
  let remaining = bytes - Buffer.byteLength(JSON.stringify({ servers }))
  for (const variable of servers.flatMap((server) => server.environment)) {
    const length = Math.min(remaining, MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH)
    variable.value = "v".repeat(length)
    remaining -= length
  }
  return { servers }
}

/** Problem of a group past {@link MAXIMUM_MCP_SETTINGS_BYTES}. */
const GROUP_SIZE_PROBLEM =
  "The MCP servers take at most 512 KiB of settings together."

/** Problem of a text that holds a lone surrogate. */
const LONE_SURROGATE_PROBLEM =
  "A setting holds only complete Unicode characters."

describe("readMcpSettings", () => {
  it("reads a valid group, ignoring every other group", async () => {
    const path = await writeSettingsFile(buildSettingsText(VALID_MCP_GROUP))

    const read = await readMcpSettings(path)

    expect(read).toEqual({ status: "read", settings: VALID_MCP_GROUP })
    expect(Object.isFrozen(read)).toBe(true)
  })

  it("fills omitted lists and freezes the settings", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          { name: "files", transport: "stdio", command: "files-server" },
          {
            name: "local",
            transport: "http",
            url: "http://127.0.0.1:8080/mcp"
          }
        ]
      })
    )

    const read = await readMcpSettings(path)

    expect(read).toEqual({
      status: "read",
      settings: {
        servers: [
          {
            name: "files",
            transport: "stdio",
            command: "files-server",
            arguments: [],
            environment: []
          },
          {
            name: "local",
            transport: "http",
            url: "http://127.0.0.1:8080/mcp",
            headers: []
          }
        ]
      }
    })
    if (read.status !== "read") throw new Error("Expected the group to be read")
    expect(Object.isFrozen(read.settings)).toBe(true)
    expect(Object.isFrozen(read.settings.servers)).toBe(true)
    expect(Object.isFrozen(read.settings.servers[0])).toBe(true)
    const [files, local] = read.settings.servers
    if (files?.transport !== "stdio" || local?.transport !== "http")
      throw new Error("Expected a stdio and an http server")
    expect(Object.isFrozen(files.arguments)).toBe(true)
    expect(Object.isFrozen(files.environment)).toBe(true)
    expect(Object.isFrozen(local.headers)).toBe(true)
  })

  it("reads a missing settings file as no server", async () => {
    const path = await createSettingsFilePath()

    const read = await readMcpSettings(path)

    expect(read).toEqual({ status: "read", settings: { servers: [] } })
    expect(Object.isFrozen(read)).toBe(true)
    if (read.status !== "read") throw new Error("Expected the group to be read")
    expect(Object.isFrozen(read.settings.servers)).toBe(true)
  })

  it.each([
    ["no mcp group", "{}"],
    ["an mcp group without servers", '{ "mcp": {} }'],
    ["an empty server list", '{ "mcp": { "servers": [] } }']
  ])("reads %s as no server", async (_label, text) => {
    const path = await writeSettingsFile(text)

    const read = await readMcpSettings(path)

    expect(read).toEqual({ status: "read", settings: { servers: [] } })
    if (read.status !== "read") throw new Error("Expected the group to be read")
    expect(Object.isFrozen(read.settings.servers)).toBe(true)
  })

  it("reads the group when another group breaks the desktop's rules", async () => {
    const path = await writeSettingsFile(
      JSON.stringify({ runtime: "not an object", mcp: VALID_MCP_GROUP })
    )

    expect(await readMcpSettings(path)).toEqual({
      status: "read",
      settings: VALID_MCP_GROUP
    })
  })

  it("reports a server name that breaks its rule with the field's path", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [{ name: "Bad Name", transport: "stdio", command: "server" }]
      })
    )

    const read = await readMcpSettings(path)

    expect(read).toEqual({
      status: "invalid",
      problems: [
        "servers.0.name: An MCP server name is lowercase letters and digits, with single hyphens between them."
      ]
    })
    expect(Object.isFrozen(read)).toBe(true)
  })

  it("reports a header value that breaks its rule without the value", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          {
            name: "remote",
            transport: "http",
            url: "https://mcp.example.com/mcp",
            headers: [{ name: "Authorization", value: `${SYNTHETIC_TOKEN}\n` }]
          }
        ]
      })
    )

    const read = await readMcpSettings(path)

    expect(read).toEqual({
      status: "invalid",
      problems: [
        "servers.0.headers.0.value: A header value is visible ASCII characters, spaces, and tabs, with no space or tab at either end."
      ]
    })
    expect(JSON.stringify(read)).not.toContain("synthetic-token")
  })

  it("reports a variable value that breaks its rule without the value", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          {
            name: "files",
            transport: "stdio",
            command: "server",
            environment: [
              { name: "FILES_TOKEN", value: `${SYNTHETIC_VARIABLE_VALUE}\n` }
            ]
          }
        ]
      })
    )

    const read = await readMcpSettings(path)

    expect(read).toEqual({
      status: "invalid",
      problems: [
        "servers.0.environment.0.value: A variable's value is up to 4096 characters, without line breaks or other control characters."
      ]
    })
    expect(JSON.stringify(read)).not.toContain("synthetic-variable")
  })

  it("reports a URL that breaks its rule without the URL", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          {
            name: "remote",
            transport: "http",
            url: "https://user:synthetic-password@mcp.example.com/mcp"
          }
        ]
      })
    )

    const read = await readMcpSettings(path)

    expect(read).toEqual({
      status: "invalid",
      problems: [
        "servers.0.url: A URL starts with https://, or http:// for localhost, 127.0.0.1, or [::1], and has no user name, password, or #."
      ]
    })
    expect(JSON.stringify(read)).not.toContain("synthetic-password")
  })

  it("reports every failed rule, each with its path", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          { name: "files", transport: "stdio", command: "" },
          {
            name: "remote",
            transport: "http",
            url: "http://mcp.example.com/mcp",
            headers: [{ name: "Host", value: "example.com" }]
          }
        ]
      })
    )

    expect(await readMcpSettings(path)).toEqual({
      status: "invalid",
      problems: [
        "servers.0.command: Too small: expected string to have >=1 characters",
        "servers.1.url: A URL starts with https://, or http:// for localhost, 127.0.0.1, or [::1], and has no user name, password, or #.",
        "servers.1.headers.0.name: Lys sets this header itself."
      ]
    })
  })

  it("reports two servers with one name at the server list", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          { name: "files", transport: "stdio", command: "one" },
          { name: "files", transport: "stdio", command: "two" }
        ]
      })
    )

    expect(await readMcpSettings(path)).toEqual({
      status: "invalid",
      problems: ["servers: Each MCP server has its own name."]
    })
  })

  it("reads a group of exactly the MCP size limit in a file the host writes with its other groups at their largest", async () => {
    const group = buildMcpGroupOfBytes(MAXIMUM_MCP_SETTINGS_BYTES)
    const text = buildLargestSettingsText(group)

    const read = await readMcpSettings(await writeSettingsFile(text))

    expect(Buffer.byteLength(JSON.stringify(group))).toBe(
      MAXIMUM_MCP_SETTINGS_BYTES
    )
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      MAXIMUM_SETTINGS_FILE_BYTES
    )
    expect(read).toEqual({ status: "read", settings: group })
  })

  it("reports a group one byte over the MCP size limit as invalid", async () => {
    const group = buildMcpGroupOfBytes(MAXIMUM_MCP_SETTINGS_BYTES + 1)

    const read = await readMcpSettings(
      await writeSettingsFile(buildSettingsText(group))
    )

    expect(read).toEqual({ status: "invalid", problems: [GROUP_SIZE_PROBLEM] })
  })

  it("counts the group's size in UTF-8 bytes, not in characters", async () => {
    const group = buildMcpGroupOfBytes(MAXIMUM_MCP_SETTINGS_BYTES)
    const [firstVariable] = group.servers[0]?.environment ?? []
    if (firstVariable === undefined) throw new Error("Expected a variable")
    firstVariable.value = "é".repeat(
      MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH / 2 + 1
    )

    const read = await readMcpSettings(
      await writeSettingsFile(buildSettingsText(group))
    )

    expect(JSON.stringify(group).length).toBeLessThan(
      MAXIMUM_MCP_SETTINGS_BYTES
    )
    expect(read).toEqual({ status: "invalid", problems: [GROUP_SIZE_PROBLEM] })
  })

  it.each([
    [
      "a command",
      { name: "files", transport: "stdio", command: "server\uD800" },
      "servers.0.command"
    ],
    [
      "an argument",
      {
        name: "files",
        transport: "stdio",
        command: "server",
        arguments: ["--token", "\uDC00"]
      },
      "servers.0.arguments.1"
    ],
    [
      "a variable value",
      {
        name: "files",
        transport: "stdio",
        command: "server",
        environment: [
          { name: "FILES_TOKEN", value: `${SYNTHETIC_VARIABLE_VALUE}\uD83D` }
        ]
      },
      "servers.0.environment.0.value"
    ],
    [
      "a URL",
      {
        name: "remote",
        transport: "http",
        url: "https://mcp.example.com/\uDC00"
      },
      "servers.0.url"
    ]
  ])(
    "reports a lone surrogate in %s, which the desktop host cannot read, as invalid",
    async (_label, server, path) => {
      const read = await readMcpSettings(
        await writeSettingsFile(buildSettingsText({ servers: [server] }))
      )

      expect(read).toEqual({
        status: "invalid",
        problems: [`${path}: ${LONE_SURROGATE_PROBLEM}`]
      })
      expect(JSON.stringify(read)).not.toContain("synthetic-variable")
    }
  )

  it("reports a URL to an internationalized domain name with its rule", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          {
            name: "remote",
            transport: "http",
            url: "https://bücher.example/mcp"
          }
        ]
      })
    )

    expect(await readMcpSettings(path)).toEqual({
      status: "invalid",
      problems: [
        "servers.0.url: A URL's host is not an internationalized domain name: no part of it starts with xn--."
      ]
    })
  })

  it("reports a header that Node's fetch cannot send with its rule", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          {
            name: "remote",
            transport: "http",
            url: "https://mcp.example.com/mcp",
            headers: [{ name: "Expect", value: "100-continue" }]
          }
        ]
      })
    )

    expect(await readMcpSettings(path)).toEqual({
      status: "invalid",
      problems: ["servers.0.headers.0.name: Lys cannot send this header."]
    })
  })

  it("reports a rule of the group itself without a path", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({ servers: [], extra: SYNTHETIC_TOKEN })
    )

    const read = await readMcpSettings(path)

    expect(read).toEqual({
      status: "invalid",
      problems: ['Unrecognized key: "extra"']
    })
    expect(JSON.stringify(read)).not.toContain("synthetic-token")
  })

  it.each([
    [
      "text that is not JSON",
      `{ "mcp": { "servers": [{ "name": "remote", "headers": [{ "name": "Authorization", "value": "${SYNTHETIC_TOKEN}" `
    ],
    ["a JSON array", "[]"],
    ["a JSON string", '"settings"'],
    ["JSON null", "null"]
  ])(
    "reports %s as unreadable, with nothing from the file",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      const read = await readMcpSettings(path)

      expect(read).toEqual({ status: "unreadable" })
      expect(JSON.stringify(read)).not.toContain("synthetic-token")
    }
  )

  it("reports bytes that are not UTF-8 as unreadable", async () => {
    const path = await writeSettingsFile(
      Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    )

    expect(await readMcpSettings(path)).toEqual({ status: "unreadable" })
  })

  it("reads a file of exactly the size limit", async () => {
    const text = buildSettingsText(VALID_MCP_GROUP)
    const path = await writeSettingsFile(
      text.padEnd(MAXIMUM_SETTINGS_FILE_BYTES, " ")
    )

    expect(await readMcpSettings(path)).toEqual({
      status: "read",
      settings: VALID_MCP_GROUP
    })
  })

  it("reports a file one byte over the size limit as unreadable", async () => {
    const text = buildSettingsText(VALID_MCP_GROUP)
    const path = await writeSettingsFile(
      text.padEnd(MAXIMUM_SETTINGS_FILE_BYTES + 1, " ")
    )

    expect(await readMcpSettings(path)).toEqual({ status: "unreadable" })
  })

  it("reports a settings path that is a folder as unreadable", async () => {
    const path = await createSettingsFilePath()
    await mkdir(path)

    expect(await readMcpSettings(path)).toEqual({ status: "unreadable" })
  })

  it("reads the file again on every call", async () => {
    const path = await createSettingsFilePath()
    const before = await readMcpSettings(path)
    await writeFile(path, buildSettingsText(VALID_MCP_GROUP))

    const after = await readMcpSettings(path)

    expect(before).toEqual({ status: "read", settings: { servers: [] } })
    expect(after).toEqual({ status: "read", settings: VALID_MCP_GROUP })
  })
})

describe("readMcpSettings on the groups shared with the desktop host", () => {
  it.each(SHARED_MCP_GROUP_CASES.filter((sharedCase) => sharedCase.accepted))(
    "reads $case, and reads what the host writes back as the same servers",
    async ({ group, written }) => {
      const read = await readMcpSettings(
        await writeSettingsFile(buildSettingsText(group))
      )
      const readWritten = await readMcpSettings(
        await writeSettingsFile(buildSettingsText(written))
      )

      expect(read).toMatchObject({ status: "read" })
      expect(readWritten).toEqual(read)
    }
  )

  it.each(SHARED_MCP_GROUP_CASES.filter((sharedCase) => !sharedCase.accepted))(
    "reports $case as invalid",
    async ({ group }) => {
      const read = await readMcpSettings(
        await writeSettingsFile(buildSettingsText(group))
      )

      expect(read).toMatchObject({ status: "invalid" })
    }
  )
})
