import { MAXIMUM_MCP_SERVER_NAME_LENGTH, mcpServerNameSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildEmptyMcpServerDraft,
  fillMcpHttpDraft,
  fillMcpStdioDraft,
  type McpServerDraft
} from "@/lib/models/mcp-server-draft"
import {
  formatMcpServerNameFromKey,
  parseMcpServerJson,
  type McpServerJsonProblem
} from "@/lib/models/mcp-server-json"

/** Draft of a new URL server, before anything is typed. */
const EMPTY_HTTP_DRAFT = buildEmptyMcpServerDraft("http")

/**
 * Draft of a command server the person already typed: a name, a command, an
 * argument, and one variable row, so the rows of a pasted server must take
 * later identities.
 */
const TYPED_STDIO_DRAFT: McpServerDraft = fillMcpStdioDraft(
  { ...buildEmptyMcpServerDraft("stdio"), name: "typed" },
  "uvx",
  ["mcp-server-time"],
  [{ name: "TZ", value: "UTC" }]
)

/**
 * Draft of a URL server the person already typed: a name, a URL, a token,
 * and one header row.
 */
const TYPED_HTTP_DRAFT: McpServerDraft = fillMcpHttpDraft(
  { ...buildEmptyMcpServerDraft("http"), name: "typed" },
  "https://mcp.example.test/typed",
  [
    { name: "Authorization", value: "Bearer typed-0000" },
    { name: "X-Typed", value: "yes" }
  ]
)

/**
 * Reads a config expected to fill the draft.
 *
 * @param text - Pasted text.
 * @param draft - Draft as it is before the paste.
 * @returns The filled draft and the number of servers of the config.
 * @throws When the text cannot fill the draft.
 */
function readFilled(text: string, draft: McpServerDraft) {
  const parse = parseMcpServerJson(text, draft)
  if (parse.status === "invalid") {
    throw new Error(`The config is invalid: ${parse.problem}`)
  }
  return parse
}

describe("parseMcpServerJson", () => {
  it("fills a command server from a Claude Desktop mcpServers map", () => {
    const text = JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/a b"],
          env: { LOG_LEVEL: "debug", ROOT: "/tmp" }
        }
      }
    })
    const firstId = EMPTY_HTTP_DRAFT.nextEntryId

    expect(parseMcpServerJson(text, EMPTY_HTTP_DRAFT)).toEqual({
      status: "filled",
      serverCount: 1,
      draft: {
        ...EMPTY_HTTP_DRAFT,
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        argumentText: '-y @modelcontextprotocol/server-filesystem "/tmp/a b"',
        environment: [
          { id: firstId, name: "LOG_LEVEL", value: "debug" },
          { id: firstId + 1, name: "ROOT", value: "/tmp" }
        ],
        nextEntryId: firstId + 2
      }
    })
  })

  it("fills a URL server from a servers map, reading its bearer header as the token", () => {
    const text = JSON.stringify({
      servers: {
        github: {
          type: "http",
          url: "https://mcp.example.test/github",
          headers: {
            "X-Api-Version": "2",
            Authorization: "Bearer fixture-0000"
          }
        }
      }
    })
    const firstId = EMPTY_HTTP_DRAFT.nextEntryId

    expect(parseMcpServerJson(text, EMPTY_HTTP_DRAFT)).toEqual({
      status: "filled",
      serverCount: 1,
      draft: {
        ...EMPTY_HTTP_DRAFT,
        name: "github",
        url: "https://mcp.example.test/github",
        signIn: "token",
        token: "fixture-0000",
        headers: [{ id: firstId, name: "X-Api-Version", value: "2" }],
        nextEntryId: firstId + 1
      }
    })
  })

  it("fills a server from an mcp_servers map", () => {
    const text = JSON.stringify({
      mcp_servers: { time: { command: "uvx", args: ["mcp-server-time"] } }
    })

    expect(readFilled(text, EMPTY_HTTP_DRAFT).draft).toMatchObject({
      name: "time",
      transport: "stdio",
      command: "uvx",
      argumentText: "mcp-server-time"
    })
  })

  it("fills a server from a map of servers by name", () => {
    const text = JSON.stringify({
      notes: { url: "https://mcp.example.test/notes" }
    })

    expect(readFilled(text, EMPTY_HTTP_DRAFT)).toMatchObject({
      serverCount: 1,
      draft: {
        name: "notes",
        transport: "http",
        url: "https://mcp.example.test/notes"
      }
    })
  })

  it("fills one server's config, keeping the draft's name", () => {
    const text = JSON.stringify({ command: "npx", args: ["-y", "server"] })

    expect(readFilled(text, TYPED_HTTP_DRAFT)).toMatchObject({
      serverCount: 1,
      draft: {
        name: "typed",
        transport: "stdio",
        command: "npx",
        argumentText: "-y server"
      }
    })
  })

  it("keeps the draft's name when the key leaves no name", () => {
    const text = JSON.stringify({ mcpServers: { "!!!": { command: "npx" } } })

    expect(readFilled(text, TYPED_HTTP_DRAFT).draft.name).toBe("typed")
  })

  it("names the server after its key, as a server name", () => {
    const text = JSON.stringify({
      mcpServers: { "My Notes_Server": { url: "https://mcp.example.test" } }
    })

    expect(readFilled(text, TYPED_HTTP_DRAFT).draft.name).toBe(
      "my-notes-server"
    )
  })

  it("reads serverUrl as the URL", () => {
    const text = JSON.stringify({
      mcpServers: { remote: { serverUrl: "https://mcp.example.test/remote" } }
    })

    expect(readFilled(text, EMPTY_HTTP_DRAFT).draft).toMatchObject({
      transport: "http",
      url: "https://mcp.example.test/remote"
    })
  })

  it("fills a URL server when its config has both a URL and a command", () => {
    const text = JSON.stringify({
      url: "https://mcp.example.test",
      command: "npx"
    })

    expect(readFilled(text, EMPTY_HTTP_DRAFT).draft).toMatchObject({
      transport: "http",
      url: "https://mcp.example.test",
      command: ""
    })
  })

  it("reads an Authorization header as the token ignoring case", () => {
    const text = JSON.stringify({
      url: "https://mcp.example.test",
      headers: { authorization: "bearer fixture-0000" }
    })

    expect(readFilled(text, EMPTY_HTTP_DRAFT).draft).toMatchObject({
      signIn: "token",
      token: "fixture-0000",
      headers: []
    })
  })

  it("keeps an Authorization header that is not a bearer token as a row", () => {
    const text = JSON.stringify({
      url: "https://mcp.example.test",
      headers: { Authorization: "Basic Zml4dHVyZQ==" }
    })

    expect(readFilled(text, TYPED_HTTP_DRAFT).draft).toMatchObject({
      signIn: "none",
      token: "",
      headers: [{ name: "Authorization", value: "Basic Zml4dHVyZQ==" }]
    })
  })

  it("uses only the first server of several and says how many there are", () => {
    const text = JSON.stringify({
      mcpServers: {
        first: { command: "npx", args: ["first"] },
        second: { url: "https://mcp.example.test/second" },
        third: { command: "uvx" }
      }
    })

    expect(readFilled(text, EMPTY_HTTP_DRAFT)).toMatchObject({
      serverCount: 3,
      draft: {
        name: "first",
        transport: "stdio",
        command: "npx",
        argumentText: "first",
        url: ""
      }
    })
  })

  it("counts the servers of a map of servers by name", () => {
    const text = JSON.stringify({
      first: { command: "npx" },
      second: { command: "uvx" }
    })

    expect(readFilled(text, EMPTY_HTTP_DRAFT)).toMatchObject({
      serverCount: 2,
      draft: { name: "first", command: "npx" }
    })
  })

  it("reads mcpServers before the other maps", () => {
    const text = JSON.stringify({
      servers: { other: { command: "uvx" } },
      mcpServers: { chosen: { command: "npx" } }
    })

    expect(readFilled(text, EMPTY_HTTP_DRAFT).draft).toMatchObject({
      name: "chosen",
      command: "npx"
    })
  })

  it("keeps a URL draft's fields when filling a command server", () => {
    const text = JSON.stringify({
      mcpServers: {
        files: { command: "npx", env: { LOG_LEVEL: "debug" } }
      }
    })
    const firstId = TYPED_HTTP_DRAFT.nextEntryId

    expect(readFilled(text, TYPED_HTTP_DRAFT).draft).toEqual({
      ...TYPED_HTTP_DRAFT,
      name: "files",
      transport: "stdio",
      command: "npx",
      argumentText: "",
      environment: [{ id: firstId, name: "LOG_LEVEL", value: "debug" }],
      nextEntryId: firstId + 1
    })
  })

  it("keeps a command draft's fields when filling a URL server", () => {
    const text = JSON.stringify({
      mcpServers: { notes: { url: "https://mcp.example.test/notes" } }
    })

    expect(readFilled(text, TYPED_STDIO_DRAFT).draft).toEqual({
      ...TYPED_STDIO_DRAFT,
      name: "notes",
      transport: "http",
      url: "https://mcp.example.test/notes",
      signIn: "none",
      token: "",
      headers: []
    })
  })

  it("replaces the rows of the filled transport with identities not used before", () => {
    const text = JSON.stringify({
      command: "npx",
      env: { A: "1", B: "2" }
    })
    const used = new Set(TYPED_STDIO_DRAFT.environment.map(({ id }) => id))

    const filled = readFilled(text, TYPED_STDIO_DRAFT).draft
    const ids = filled.environment.map(({ id }) => id)

    expect(filled.environment.map(({ name }) => name)).toEqual(["A", "B"])
    expect(new Set(ids).size).toBe(2)
    expect(ids.some((id) => used.has(id))).toBe(false)
  })

  it("reads numbers and Booleans as text", () => {
    const commandText = JSON.stringify({
      command: "npx",
      args: ["--port", 8080, true],
      env: { PORT: 8080, DEBUG: false }
    })
    const urlText = JSON.stringify({
      url: "https://mcp.example.test",
      headers: { "X-Retry": 3, "X-Debug": true }
    })

    expect(readFilled(commandText, EMPTY_HTTP_DRAFT).draft).toMatchObject({
      argumentText: "--port 8080 true",
      environment: [
        { name: "PORT", value: "8080" },
        { name: "DEBUG", value: "false" }
      ]
    })
    expect(readFilled(urlText, EMPTY_HTTP_DRAFT).draft).toMatchObject({
      headers: [
        { name: "X-Retry", value: "3" },
        { name: "X-Debug", value: "true" }
      ]
    })
  })

  it.each([
    ["a path", "/srv/app"],
    ["a value that is not text", 42]
  ])("ignores a working directory given as %s", (_case, cwd) => {
    const server = { command: "npx", args: ["server"] }

    expect(
      parseMcpServerJson(JSON.stringify({ ...server, cwd }), EMPTY_HTTP_DRAFT)
    ).toEqual(parseMcpServerJson(JSON.stringify(server), EMPTY_HTTP_DRAFT))
  })

  it.each(["http", "streamable-http"])(
    "fills a URL server whose type is %s",
    (type) => {
      const text = JSON.stringify({ url: "https://mcp.example.test", type })

      expect(readFilled(text, EMPTY_HTTP_DRAFT).draft.url).toBe(
        "https://mcp.example.test"
      )
    }
  )

  it.each<[string, string, McpServerJsonProblem]>([
    ["empty text", "", "not-json"],
    ["an unclosed object", '{"mcpServers": {', "not-json"],
    ["single-quoted keys", "{'command': 'npx'}", "not-json"],
    ["an array", '[{"command": "npx"}]', "not-object"],
    ["a number", "42", "not-object"],
    ["null", "null", "not-object"],
    ["a string", '"npx"', "not-object"],
    ["an empty object", "{}", "no-servers"],
    ["an empty mcpServers map", '{"mcpServers": {}}', "no-servers"],
    ["a servers list", '{"servers": [{"command": "npx"}]}', "no-servers"],
    ["an mcp_servers text", '{"mcp_servers": "npx"}', "no-servers"],
    ["a null mcpServers map", '{"mcpServers": null}', "no-servers"],
    [
      "a first server without a command or URL",
      '{"mcpServers": {"a": {"args": ["-y"]}, "b": {"command": "npx"}}}',
      "no-command-or-url"
    ],
    [
      "a map whose first value is not an object",
      '{"a": 1}',
      "no-command-or-url"
    ],
    ["an object of settings", '{"name": "files"}', "no-command-or-url"],
    [
      "arguments as text",
      '{"command": "npx", "args": "-y"}',
      "unreadable-values"
    ],
    [
      "an argument that is an object",
      '{"command": "npx", "args": ["-y", {"a": 1}]}',
      "unreadable-values"
    ],
    [
      "a null argument",
      '{"command": "npx", "args": [null]}',
      "unreadable-values"
    ],
    [
      "variables as a list",
      '{"command": "npx", "env": ["A=1"]}',
      "unreadable-values"
    ],
    [
      "a variable that is an object",
      '{"command": "npx", "env": {"A": {"v": 1}}}',
      "unreadable-values"
    ],
    [
      "a null header",
      '{"url": "https://mcp.example.test", "headers": {"X-A": null}}',
      "unreadable-values"
    ],
    [
      "headers as a list",
      '{"url": "https://mcp.example.test", "headers": ["X-A: 1"]}',
      "unreadable-values"
    ],
    ["a command that is not text", '{"command": 5}', "unreadable-values"],
    [
      "a URL that is not text",
      '{"url": ["https://mcp.example.test"]}',
      "unreadable-values"
    ],
    [
      "an SSE server",
      '{"mcpServers": {"old": {"type": "sse", "url": "https://mcp.example.test/sse"}}}',
      "sse"
    ],
    [
      "an SSE server in capitals",
      '{"type": "SSE", "url": "https://mcp.example.test/sse"}',
      "sse"
    ]
  ])("refuses %s", (_case, text, problem) => {
    expect(parseMcpServerJson(text, TYPED_HTTP_DRAFT)).toEqual({
      status: "invalid",
      problem
    })
  })

  it("returns frozen outcomes and a frozen draft", () => {
    const filled = parseMcpServerJson('{"command": "npx"}', EMPTY_HTTP_DRAFT)
    const invalid = parseMcpServerJson("[]", EMPTY_HTTP_DRAFT)

    expect(Object.isFrozen(filled)).toBe(true)
    expect(filled.status === "filled" && Object.isFrozen(filled.draft)).toBe(
      true
    )
    expect(Object.isFrozen(invalid)).toBe(true)
  })
})

describe("formatMcpServerNameFromKey", () => {
  it.each([
    ["a name", "filesystem", "filesystem"],
    ["capitals", "GitHub", "github"],
    ["an underscore", "my_server", "my-server"],
    ["runs of other characters", "My  Cool__Server!!", "my-cool-server"],
    ["a dot and digits", "server.v2", "server-v2"],
    ["separators at either end", "--edge--", "edge"],
    ["a letter outside ASCII", "café-server", "caf-server"],
    ["nothing a name can hold", "!!!", ""],
    ["an empty key", "", ""]
  ])("formats %s", (_case, key, name) => {
    expect(formatMcpServerNameFromKey(key)).toBe(name)
  })

  it("cuts a long key to the longest name", () => {
    expect(
      formatMcpServerNameFromKey("a".repeat(MAXIMUM_MCP_SERVER_NAME_LENGTH + 5))
    ).toBe("a".repeat(MAXIMUM_MCP_SERVER_NAME_LENGTH))
  })

  it("drops a hyphen the cut leaves at the end", () => {
    expect(
      formatMcpServerNameFromKey(
        `${"a".repeat(MAXIMUM_MCP_SERVER_NAME_LENGTH - 1)}_tail`
      )
    ).toBe("a".repeat(MAXIMUM_MCP_SERVER_NAME_LENGTH - 1))
  })

  it.each([
    "Brave Search",
    "@scope/server_v2",
    "  spaced  ",
    "ab_".repeat(MAXIMUM_MCP_SERVER_NAME_LENGTH)
  ])("formats %j as a name the shared schema accepts", (key) => {
    expect(
      mcpServerNameSchema.safeParse(formatMcpServerNameFromKey(key)).success
    ).toBe(true)
  })
})
