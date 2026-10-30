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
import { domainToASCII } from "node:url"
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

/** Problem of a URL whose internationalized domain name breaks its rule. */
const INTERNATIONALIZED_HOST_PROBLEM =
  "A URL's host is plain ASCII or an internationalized domain name whose every part is lowercase letters of one of the Latin, Greek, Cyrillic, Chinese, Japanese, or Korean scripts, digits, and hyphens."

/** One range of {@link LISTED_LETTER_RANGES}. */
type ListedLetterRange = {
  /** The range as the configuration reference names it. */
  letters: string
  /** First code point of the range. */
  first: number
  /** Last code point of the range, inclusive. */
  last: number
  /** 2 when only every other code point of the range is listed. */
  step: 1 | 2
}

/**
 * Letters beyond ASCII that a part of an internationalized domain name may
 * hold, as the configuration reference lists them.
 */
const LISTED_LETTER_RANGES: readonly ListedLetterRange[] = [
  { letters: "à to ö", first: 0xe0, last: 0xf6, step: 1 },
  { letters: "ø to ÿ", first: 0xf8, last: 0xff, step: 1 },
  { letters: "ā to ı", first: 0x101, last: 0x131, step: 2 },
  { letters: "ĵ and ķ", first: 0x135, last: 0x137, step: 2 },
  { letters: "ĸ to ľ", first: 0x138, last: 0x13e, step: 2 },
  { letters: "ł to ň", first: 0x142, last: 0x148, step: 2 },
  { letters: "ŋ to ŷ", first: 0x14b, last: 0x177, step: 2 },
  { letters: "ź to ž", first: 0x17a, last: 0x17e, step: 2 },
  { letters: "ά to ρ", first: 0x3ac, last: 0x3c1, step: 1 },
  { letters: "σ to ώ", first: 0x3c3, last: 0x3ce, step: 1 },
  { letters: "а to џ", first: 0x430, last: 0x45f, step: 1 },
  { letters: "ぁ to ん", first: 0x3041, last: 0x3093, step: 1 },
  { letters: "ァ to ヶ", first: 0x30a1, last: 0x30f6, step: 1 },
  { letters: "ー", first: 0x30fc, last: 0x30fc, step: 1 },
  { letters: "一 to 龥", first: 0x4e00, last: 0x9fa5, step: 1 },
  { letters: "가 to 힣", first: 0xac00, last: 0xd7a3, step: 1 }
]

/**
 * Parts of a domain name that each hold one character off that list. An
 * ASCII symbol; Latin letters beside listed ones, uppercase or lowercase,
 * and ones URL parsers map; Greek, Cyrillic, kana, ideographs, and Hangul
 * past the listed ranges; an emoji, a combining mark, and a middle dot stand
 * between digits. Arabic and Hebrew letters stand first, before a digit, as
 * the right-to-left rule of RFC 5893 asks, which some URL parsers enforce.
 */
const UNLISTED_CHARACTER_LABELS = [
  ...[
    ..."_À×ß÷ĀİĲĳĴŀŁŉŊŸŹſΆΐςϐЯѠゔゝヷ・ヽ\u3400\u9fa6\ud7b0\u{20000}\u{1f600}\u0301\u00b7"
  ].map((character) => `1${character}2`),
  ...["\u0628", "\u05d0"].map((letter) => `${letter}2`)
]

/** One sample of RFC 3492, section 7.1. */
type PunycodeSample = {
  /** Letter of the sample in the RFC. */
  sample: string
  /** Text of the sample. */
  text: string
  /** Punycode of the text, as the RFC writes it. */
  punycode: string
}

/**
 * The samples of RFC 3492, section 7.1, whose text is lowercase letters of
 * one listed script, digits, and hyphens, apart from ASCII letters in
 * uppercase, which URL parsers lowercase.
 */
const ACCEPTED_PUNYCODE_SAMPLES: readonly PunycodeSample[] = [
  {
    sample: "B",
    text: "他们为什么不说中文",
    punycode: "ihqwcrb4cv8a8dqg056pqjye"
  },
  {
    sample: "C",
    text: "他們爲什麽不說中文",
    punycode: "ihqwctvzc91f659drss3x8bo0yb"
  },
  {
    sample: "D",
    text: "Pročprostěnemluvíčesky",
    punycode: "Proprostnemluvesky-uyb24dma41a"
  },
  {
    sample: "G",
    text: "なぜみんな日本語を話してくれないのか",
    punycode: "n8jok5ay5dzabd5bym9f0cm5685rrjetr6pdxa"
  },
  {
    sample: "I",
    text: "почемужеонинеговорятпорусски",
    punycode: "b1abfaaepdrnnbgefbaDotcwatmq2g4l"
  },
  {
    sample: "J",
    text: "PorquénopuedensimplementehablarenEspañol",
    punycode: "PorqunopuedensimplementehablarenEspaol-fmd56a"
  },
  { sample: "O", text: "ひとつ屋根の下2", punycode: "2-u9tlzr9756bt3uc0v" },
  { sample: "R", text: "そのスピードで", punycode: "d9juau41awczczp" }
]

/**
 * The samples of RFC 3492, section 7.1, that the host rule refuses: other
 * scripts, scripts mixed in one part, letters off the list, or punycode
 * longer than a label holds. Sample S, which holds spaces, is no host.
 */
const REFUSED_PUNYCODE_SAMPLES: readonly PunycodeSample[] = [
  {
    sample: "A",
    text: "ليهمابتكلموشعربي؟",
    punycode: "egbpdaj6bu4bxfgehfvwxn"
  },
  {
    sample: "E",
    text: "למההםפשוטלאמדבריםעברית",
    punycode: "4dbcagdahymbxekheh6e0a7fei0b"
  },
  {
    sample: "F",
    text: "यहलोगहिन्दीक्योंनहींबोलसकतेहैं",
    punycode: "i1baa7eci9glrd9b2ae1bj0hfcgg6iyaf8o0a1dig0cd"
  },
  {
    sample: "H",
    text: "세계의모든사람들이한국어를이해한다면얼마나좋을까",
    punycode:
      "989aomsvi5e83db1d2a355cv1e0vak1dwrv93d5xbh15a0dt30a5jpsd879ccm6fea98c"
  },
  {
    sample: "K",
    text: "TạisaohọkhôngthểchỉnóitiếngViệt",
    punycode: "TisaohkhngthchnitingVit-kjcr8268qyxafd2f1b9g"
  },
  { sample: "L", text: "3年B組金八先生", punycode: "3B-ww4c5e180e575a65lsy2b" },
  {
    sample: "M",
    text: "安室奈美恵-with-SUPER-MONKEYS",
    punycode: "-with-SUPER-MONKEYS-pc58ag80a8qai00g7n9n"
  },
  {
    sample: "N",
    text: "Hello-Another-Way-それぞれの場所",
    punycode: "Hello-Another-Way--fc4qua05auwb3674vfr0b"
  },
  {
    sample: "P",
    text: "MajiでKoiする5秒前",
    punycode: "MajiKoi5-783gue6qz075azm5e"
  },
  { sample: "Q", text: "パフィーdeルンバ", punycode: "de-jg4avhby1noc0d" }
]

/** One URL server as a settings file holds it, without headers. */
type UrlServerEntry = {
  /** Server name. */
  name: string
  /** Always a URL server. */
  transport: "http"
  /** URL text. */
  url: string
}

/**
 * Builds the two URLs of one RFC 3492 sample: to the sample's text as a
 * host part, and to its punycode.
 *
 * @param sample - The sample.
 * @returns A group of two servers, one per URL.
 */
function buildPunycodeSampleGroup(sample: PunycodeSample): {
  servers: UrlServerEntry[]
} {
  const textServer: UrlServerEntry = {
    name: "text",
    transport: "http",
    url: `https://${sample.text}.example/mcp`
  }
  const punycodeServer: UrlServerEntry = {
    name: "punycode",
    transport: "http",
    url: `https://xn--${sample.punycode}.example/mcp`
  }
  const servers = [textServer, punycodeServer]
  return { servers }
}

/**
 * Lists the letters of one listed range.
 *
 * @param range - The range.
 * @returns Its letters, in code point order.
 */
function listLetters(range: ListedLetterRange): string[] {
  return Array.from(
    { length: Math.floor((range.last - range.first) / range.step) + 1 },
    (_, index) => String.fromCodePoint(range.first + index * range.step)
  )
}

/**
 * Builds the servers of letters, each in a host part between two digits,
 * typed as itself and as the punycode Node writes for it, in uppercase.
 *
 * @param letters - The letters, at most eight, so the servers fit a group.
 * @returns Two servers per letter, with distinct names, as the reader
 * returns them.
 */
function buildLetterServers(
  letters: readonly string[]
): { name: string; transport: "http"; url: string; headers: [] }[] {
  return letters.flatMap((letter, index) => {
    const host = `1${letter}2.example`
    const punycodeHost = domainToASCII(host).toUpperCase()
    return [
      {
        name: `text-${index}`,
        transport: "http",
        url: `https://${host}/mcp`,
        headers: []
      },
      {
        name: `punycode-${index}`,
        transport: "http",
        url: `https://${punycodeHost}/mcp`,
        headers: []
      }
    ]
  })
}

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

  it("reports a URL to a refused internationalized domain name with its rule", async () => {
    const path = await writeSettingsFile(
      buildSettingsText({
        servers: [
          {
            name: "remote",
            transport: "http",
            url: "https://BÜCHER.example/mcp"
          }
        ]
      })
    )

    expect(await readMcpSettings(path)).toEqual({
      status: "invalid",
      problems: [`servers.0.url: ${INTERNATIONALIZED_HOST_PROBLEM}`]
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

describe("readMcpSettings on internationalized domain names", () => {
  it.each(LISTED_LETTER_RANGES)(
    "reads the listed letters $letters, typed as themselves and as punycode",
    async (range) => {
      const path = await createSettingsFilePath()
      const letters = listLetters(range)

      for (let index = 0; index < letters.length; index += 8) {
        const batch = letters.slice(index, index + 8)
        const servers = buildLetterServers(batch)
        const settings = { servers }
        await writeFile(path, buildSettingsText(settings))

        expect(await readMcpSettings(path), batch.join(" ")).toEqual({
          status: "read",
          settings
        })
      }
    }
  )

  it("reports each unlisted character in a part of an internationalized domain name as a break of its rule", async () => {
    const path = await createSettingsFilePath()

    for (const label of UNLISTED_CHARACTER_LABELS) {
      const url = `https://${label}.bücher.example/mcp`
      const servers = [{ name: "docs", transport: "http", url }]
      await writeFile(path, buildSettingsText({ servers }))

      expect(await readMcpSettings(path), url).toEqual({
        status: "invalid",
        problems: [`servers.0.url: ${INTERNATIONALIZED_HOST_PROBLEM}`]
      })
    }
  })

  it.each(ACCEPTED_PUNYCODE_SAMPLES)(
    "reads RFC 3492 sample $sample, typed as its text and as its punycode",
    async (sample) => {
      const group = buildPunycodeSampleGroup(sample)
      const writtenServers = group.servers.map((server) => ({
        ...server,
        headers: []
      }))
      const settings = { servers: writtenServers }

      const read = await readMcpSettings(
        await writeSettingsFile(buildSettingsText(group))
      )

      expect(read).toEqual({ status: "read", settings })
    }
  )

  it.each(REFUSED_PUNYCODE_SAMPLES)(
    "reports RFC 3492 sample $sample, typed as its text and as its punycode, as invalid",
    async (sample) => {
      const read = await readMcpSettings(
        await writeSettingsFile(
          buildSettingsText(buildPunycodeSampleGroup(sample))
        )
      )

      expect(read).toEqual({
        status: "invalid",
        problems: [
          `servers.0.url: ${INTERNATIONALIZED_HOST_PROBLEM}`,
          `servers.1.url: ${INTERNATIONALIZED_HOST_PROBLEM}`
        ]
      })
    }
  )
})
