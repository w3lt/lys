import { mcpServerSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildMcpServerDraft,
  EMPTY_MCP_SERVER_DRAFT,
  parseMcpServerDraft,
  type McpServerDraft
} from "@/lib/models/mcp-server-draft"
import { STORED_MCP_SETTINGS } from "../../support/settingsFixtures"

/** Names of no other saved server. */
const NO_OTHER_NAMES: ReadonlySet<string> = new Set()

/** Draft of a valid command server, as the person types it. */
const COMMAND_DRAFT: McpServerDraft = Object.freeze({
  ...EMPTY_MCP_SERVER_DRAFT,
  name: "files",
  command: "/opt/homebrew/bin/npx",
  argumentLines: "-y\n@modelcontextprotocol/server-filesystem",
  environmentLines: "LOG_LEVEL=debug"
})

/** Draft of a valid URL server, as the person types it. */
const URL_DRAFT: McpServerDraft = Object.freeze({
  ...EMPTY_MCP_SERVER_DRAFT,
  name: "notes",
  transport: "http",
  url: "https://mcp.example.test/notes",
  headerLines: "Authorization: Bearer fixture-0000"
})

/**
 * Reads the problems of a draft expected to be invalid.
 *
 * @param draft - Draft as typed.
 * @param otherServerNames - Names of the other saved servers.
 * @returns The problems by field.
 * @throws When the draft is valid.
 */
function readProblems(
  draft: McpServerDraft,
  otherServerNames: ReadonlySet<string> = NO_OTHER_NAMES
) {
  const parse = parseMcpServerDraft(draft, otherServerNames)
  if (parse.status === "valid") throw new Error("The draft is valid")
  return parse.problems
}

describe("buildMcpServerDraft", () => {
  it("writes a command server's lists one item per line, and its variables as NAME=value", () => {
    expect(buildMcpServerDraft(STORED_MCP_SETTINGS.servers[0])).toEqual({
      name: "files",
      transport: "stdio",
      command: "/opt/homebrew/bin/npx",
      argumentLines: "-y\n@modelcontextprotocol/server-filesystem\n/tmp",
      environmentLines: "LOG_LEVEL=debug",
      url: "",
      headerLines: ""
    })
  })

  it("writes a URL server's headers as Name: value", () => {
    expect(buildMcpServerDraft(STORED_MCP_SETTINGS.servers[1])).toEqual({
      name: "notes",
      transport: "http",
      command: "",
      argumentLines: "",
      environmentLines: "",
      url: "https://mcp.example.test/notes",
      headerLines: "Authorization: Bearer fixture-0000"
    })
  })

  it.each([
    [
      "a command server with an empty value, an = in a value, and a spaced argument",
      {
        name: "tools",
        transport: "stdio",
        command: "uvx",
        arguments: ["--from", "two words"],
        environment: [
          { name: "EMPTY", value: "" },
          { name: "QUERY", value: "a=b" }
        ]
      }
    ],
    [
      "a URL server with an empty header value and a : in a value",
      {
        name: "web",
        transport: "http",
        url: "http://[::1]:8080/mcp",
        headers: [
          { name: "X-Empty", value: "" },
          { name: "X-Time", value: "12:30" }
        ]
      }
    ]
  ])("reads back %s as the same settings", (_label, candidate) => {
    const server = mcpServerSettingsSchema.parse(candidate)

    expect(
      parseMcpServerDraft(buildMcpServerDraft(server), NO_OTHER_NAMES)
    ).toEqual({ status: "valid", server })
  })

  it("returns a frozen draft", () => {
    expect(
      Object.isFrozen(buildMcpServerDraft(STORED_MCP_SETTINGS.servers[1]))
    ).toBe(true)
  })
})

describe("parseMcpServerDraft", () => {
  it("reads a command draft as the shared settings, ignoring the URL fields", () => {
    const parse = parseMcpServerDraft(
      { ...COMMAND_DRAFT, url: "not a url", headerLines: "broken" },
      NO_OTHER_NAMES
    )

    expect(parse).toEqual({
      status: "valid",
      server: {
        name: "files",
        transport: "stdio",
        command: "/opt/homebrew/bin/npx",
        arguments: ["-y", "@modelcontextprotocol/server-filesystem"],
        environment: [{ name: "LOG_LEVEL", value: "debug" }]
      }
    })
    expect(Object.isFrozen(parse)).toBe(true)
  })

  it("reads a URL draft as the shared settings, ignoring the command fields", () => {
    expect(
      parseMcpServerDraft(
        { ...URL_DRAFT, command: "", environmentLines: "broken" },
        NO_OTHER_NAMES
      )
    ).toEqual({
      status: "valid",
      server: {
        name: "notes",
        transport: "http",
        url: "https://mcp.example.test/notes",
        headers: [{ name: "Authorization", value: "Bearer fixture-0000" }]
      }
    })
  })

  it("trims the name, command, and URL, and skips empty lines", () => {
    const commandParse = parseMcpServerDraft(
      {
        ...COMMAND_DRAFT,
        name: "  files ",
        command: " npx\t",
        argumentLines: "\n-y\n\n",
        environmentLines: "\n LOG_LEVEL =debug\n"
      },
      NO_OTHER_NAMES
    )
    const urlParse = parseMcpServerDraft(
      {
        ...URL_DRAFT,
        url: " https://mcp.example.test/notes ",
        headerLines: "\nAuthorization:  Bearer fixture-0000\t\n"
      },
      NO_OTHER_NAMES
    )

    expect(commandParse).toMatchObject({
      status: "valid",
      server: {
        name: "files",
        command: "npx",
        arguments: ["-y"],
        environment: [{ name: "LOG_LEVEL", value: "debug" }]
      }
    })
    expect(urlParse).toMatchObject({
      status: "valid",
      server: {
        url: "https://mcp.example.test/notes",
        headers: [{ name: "Authorization", value: "Bearer fixture-0000" }]
      }
    })
  })

  it("keeps an argument's spaces, since a line of spaces is an argument", () => {
    expect(
      parseMcpServerDraft(
        { ...COMMAND_DRAFT, argumentLines: " two words " },
        NO_OTHER_NAMES
      )
    ).toMatchObject({
      status: "valid",
      server: { arguments: [" two words "] }
    })
  })

  it("splits a variable at its first = and a header at its first :", () => {
    const commandParse = parseMcpServerDraft(
      { ...COMMAND_DRAFT, environmentLines: "QUERY=a=b" },
      NO_OTHER_NAMES
    )
    const urlParse = parseMcpServerDraft(
      { ...URL_DRAFT, headerLines: "X-Time: 12:30" },
      NO_OTHER_NAMES
    )

    expect(commandParse).toMatchObject({
      server: { environment: [{ name: "QUERY", value: "a=b" }] }
    })
    expect(urlParse).toMatchObject({
      server: { headers: [{ name: "X-Time", value: "12:30" }] }
    })
  })

  it("names the first line that is not written as a variable or a header", () => {
    expect(
      readProblems({
        ...COMMAND_DRAFT,
        environmentLines: "LOG_LEVEL=debug\n\nVERBOSE\nQUIET"
      })
    ).toEqual({ environment: "Line 3: write each variable as NAME=value." })
    expect(
      readProblems({ ...URL_DRAFT, headerLines: "Authorization Bearer x" })
    ).toEqual({ headers: "Line 1: write each header as Name: value." })
  })

  it("says each empty required field needs a value", () => {
    expect(readProblems({ ...EMPTY_MCP_SERVER_DRAFT, name: "files" })).toEqual({
      command:
        "Enter the command that starts the server, up to 1024 characters."
    })
    expect(
      readProblems({ ...EMPTY_MCP_SERVER_DRAFT, transport: "http" })
    ).toEqual({
      name: "An MCP server name is lowercase letters and digits, with single hyphens between them.",
      url: "A URL starts with https://, or http:// for localhost, 127.0.0.1, or [::1], and has no user name, password, or #."
    })
  })

  it("gives the schema's sentence for a name that breaks the name rule", () => {
    expect(readProblems({ ...COMMAND_DRAFT, name: "My Files" })).toEqual({
      name: "An MCP server name is lowercase letters and digits, with single hyphens between them."
    })
  })

  it("says how long a name may be", () => {
    expect(readProblems({ ...COMMAND_DRAFT, name: "a".repeat(21) })).toEqual({
      name: "An MCP server name is up to 20 characters."
    })
  })

  it("refuses a name another saved server has", () => {
    expect(readProblems(COMMAND_DRAFT, new Set(["files", "notes"]))).toEqual({
      name: "Another MCP server already has this name."
    })
  })

  it("prefers the name rule to the taken name", () => {
    expect(
      readProblems({ ...COMMAND_DRAFT, name: "Files" }, new Set(["Files"]))
    ).toEqual({
      name: "An MCP server name is lowercase letters and digits, with single hyphens between them."
    })
  })

  it("starts an item's problem with its line, counting skipped empty lines", () => {
    expect(
      readProblems({
        ...URL_DRAFT,
        headerLines: "Authorization: Bearer x\n\nContent-Type: application/json"
      })
    ).toEqual({ headers: "Line 3: Lys sets this header itself." })
    expect(
      readProblems({
        ...COMMAND_DRAFT,
        environmentLines: "LOG_LEVEL=debug\n1BAD=x"
      })
    ).toEqual({
      environment:
        "Line 2: A variable name is up to 128 ASCII letters, digits, and underscores, not starting with a digit."
    })
  })

  it("says how long a header value may be, on its line", () => {
    expect(
      readProblems({
        ...URL_DRAFT,
        headerLines: `X-Long: ${"v".repeat(8193)}`
      })
    ).toEqual({ headers: "Line 1: A header value is up to 8192 characters." })
  })

  it("says how many items a list may hold", () => {
    expect(
      readProblems({
        ...COMMAND_DRAFT,
        argumentLines: Array.from({ length: 65 }, () => "-v").join("\n")
      })
    ).toEqual({ arguments: "A server takes at most 64 arguments." })
    expect(
      readProblems({
        ...URL_DRAFT,
        headerLines: Array.from(
          { length: 33 },
          (_, index) => `X-H${index}: v`
        ).join("\n")
      })
    ).toEqual({ headers: "A server is sent at most 32 headers." })
  })

  it("refuses a variable set twice", () => {
    expect(
      readProblems({ ...COMMAND_DRAFT, environmentLines: "A=1\nA=2" })
    ).toEqual({ environment: "A server sets each environment variable once." })
  })

  it("refuses a URL that is not https or loopback http", () => {
    expect(
      readProblems({ ...URL_DRAFT, url: "http://mcp.example.test" })
    ).toEqual({
      url: "A URL starts with https://, or http:// for localhost, 127.0.0.1, or [::1], and has no user name, password, or #."
    })
  })

  it("reports the first problem of each field at once", () => {
    expect(
      readProblems({
        ...COMMAND_DRAFT,
        name: "",
        command: "",
        environmentLines: "VERBOSE"
      })
    ).toEqual({
      name: "An MCP server name is lowercase letters and digits, with single hyphens between them.",
      command:
        "Enter the command that starts the server, up to 1024 characters.",
      environment: "Line 1: write each variable as NAME=value."
    })
  })

  it("returns frozen problems", () => {
    const parse = parseMcpServerDraft(EMPTY_MCP_SERVER_DRAFT, NO_OTHER_NAMES)

    expect(Object.isFrozen(parse)).toBe(true)
    expect(parse.status === "invalid" && Object.isFrozen(parse.problems)).toBe(
      true
    )
  })
})
