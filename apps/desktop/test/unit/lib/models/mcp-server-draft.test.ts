import {
  MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT,
  MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH,
  MAXIMUM_MCP_COMMAND_LENGTH,
  MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH,
  MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT,
  MAXIMUM_MCP_HEADER_COUNT,
  MAXIMUM_MCP_HEADER_VALUE_LENGTH,
  MAXIMUM_MCP_SERVER_NAME_LENGTH,
  mcpServerSettingsSchema
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  addMcpDraftEntry,
  buildEmptyMcpServerDraft,
  buildMcpServerDraft,
  fillMcpHttpDraft,
  fillMcpStdioDraft,
  isMcpServerDraftChanged,
  parseMcpServerDraft,
  readBearerToken,
  removeMcpDraftEntry,
  updateMcpDraftEntry,
  type McpDraftEntry,
  type McpDraftEntryList,
  type McpServerDraft
} from "@/lib/models/mcp-server-draft"
import { STORED_MCP_SETTINGS } from "../../support/settingsFixtures"

/** Name and value typed in one row. */
type RowText = Pick<McpDraftEntry, "name" | "value">

/** Names of no other saved server. */
const NO_OTHER_NAMES: ReadonlySet<string> = new Set()

/** Row the person added and wrote nothing in. */
const BLANK_ROW: RowText = Object.freeze({ name: "", value: "" })

/** The shared schema's sentence for a name that breaks the name rule. */
const NAME_RULE_PROBLEM =
  "An MCP server name is lowercase letters and digits, with single hyphens between them."

/** The shared schema's sentence for a URL Lys may not send requests to. */
const URL_RULE_PROBLEM =
  "A URL starts with https://, or http:// for localhost, 127.0.0.1, or [::1], and has no user name, password, or #."

/** The shared schema's sentence for a variable name that breaks its rule. */
const VARIABLE_NAME_PROBLEM =
  "A variable name is up to 128 ASCII letters, digits, and underscores, not starting with a digit."

/** Problem of an empty token while signing in with one. */
const EMPTY_TOKEN_PROBLEM = "Enter the token, or set sign-in to None."

/** Problem of a token that is not a valid header value. */
const TOKEN_FORMAT_PROBLEM =
  "A token is visible ASCII characters and spaces, without line breaks."

/** Problem of an Authorization header row beside a token. */
const AUTHORIZATION_HEADER_PROBLEM =
  "The token is sent as the Authorization header. Remove this header, or set sign-in to None."

/** Problem of a name another saved server has. */
const DUPLICATE_NAME_PROBLEM = "Another MCP server already has this name."

/** Text before the token in the value of the header it is sent in. */
const TOKEN_VALUE_PREFIX = "Bearer "

/** Most characters of a token: a header value less the token's prefix. */
const MAXIMUM_TOKEN_LENGTH =
  MAXIMUM_MCP_HEADER_VALUE_LENGTH - TOKEN_VALUE_PREFIX.length

/** Draft of a valid command server without variables, as typed. */
const COMMAND_DRAFT: McpServerDraft = Object.freeze({
  ...buildEmptyMcpServerDraft("stdio"),
  name: "files",
  command: "/opt/homebrew/bin/npx",
  argumentText: "-y @modelcontextprotocol/server-filesystem"
})

/** Draft of a valid URL server without sign-in or headers, as typed. */
const URL_DRAFT: McpServerDraft = Object.freeze({
  ...buildEmptyMcpServerDraft("http"),
  name: "notes",
  url: "https://mcp.example.test/notes"
})

/** {@link URL_DRAFT} signing in with a made-up token. */
const TOKEN_DRAFT: McpServerDraft = Object.freeze({
  ...URL_DRAFT,
  signIn: "token",
  token: "fixture-0000"
})

/**
 * Appends rows to one list of a draft as the editor does: each row is added
 * empty, then typed in.
 *
 * @param draft - Draft, left unchanged.
 * @param list - List that takes the rows.
 * @param rows - Name and value of each new row, in order.
 * @returns The draft with the rows at the end of the list.
 */
function appendRows(
  draft: McpServerDraft,
  list: McpDraftEntryList,
  rows: readonly RowText[]
): McpServerDraft {
  let current = draft
  for (const row of rows) {
    const addition = addMcpDraftEntry(current, list)
    current = updateMcpDraftEntry(addition.draft, list, {
      id: addition.entryId,
      ...row
    })
  }
  return current
}

/**
 * Builds rows of distinct header names.
 *
 * @param count - Number of rows.
 * @returns Rows named `X-H0`, `X-H1`, and so on, each with the value `v`.
 */
function buildHeaderRows(count: number): readonly RowText[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `X-H${index}`,
    value: "v"
  }))
}

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

describe("buildEmptyMcpServerDraft", () => {
  it.each(["stdio", "http"] as const)(
    "builds a frozen %s draft with every field empty, no row, and no sign-in",
    (transport) => {
      const draft = buildEmptyMcpServerDraft(transport)

      expect(draft).toMatchObject({
        name: "",
        transport,
        command: "",
        argumentText: "",
        environment: [],
        url: "",
        signIn: "none",
        token: "",
        headers: []
      })
      expect(Object.isFrozen(draft)).toBe(true)
    }
  )
})

describe("readBearerToken", () => {
  it.each([
    ["Authorization", "Bearer fixture-0000", "fixture-0000"],
    ["authorization", "bearer fixture-0000", "fixture-0000"],
    ["AUTHORIZATION", "BEARER fixture-0000", "fixture-0000"],
    ["Authorization", "Bearer \t fixture-0000", "fixture-0000"],
    ["Authorization", "Bearer two words", "two words"]
  ])("reads the token of %s: %s", (name, value, token) => {
    expect(readBearerToken({ name, value })).toBe(token)
  })

  it.each([
    ["an Authorization header of another scheme", "Authorization", "Basic xyz"],
    ["a bearer header without a token", "Authorization", "Bearer"],
    ["a bearer header of spaces", "Authorization", "Bearer   "],
    ["a bearer value without a space", "Authorization", "Bearerxyz"],
    ["another header", "X-Token", "Bearer fixture-0000"],
    ["a proxy header", "Proxy-Authorization", "Bearer fixture-0000"]
  ])("reads no token from %s", (_case, name, value) => {
    expect(readBearerToken({ name, value })).toBeUndefined()
  })
})

describe("fillMcpHttpDraft", () => {
  it("turns a bearer header among others into the token, numbering the others from the next row identity", () => {
    const start = appendRows(COMMAND_DRAFT, "environment", [
      { name: "A", value: "1" }
    ])
    const firstId = start.nextEntryId

    expect(
      fillMcpHttpDraft(start, "https://mcp.example.test/notes", [
        { name: "X-A", value: "1" },
        { name: "authorization", value: "bearer fixture-0000" },
        { name: "X-B", value: "2" }
      ])
    ).toEqual({
      ...start,
      transport: "http",
      url: "https://mcp.example.test/notes",
      signIn: "token",
      token: "fixture-0000",
      headers: [
        { id: firstId, name: "X-A", value: "1" },
        { id: firstId + 1, name: "X-B", value: "2" }
      ],
      nextEntryId: firstId + 2
    })
  })

  it("turns only the first bearer header into the token", () => {
    const draft = fillMcpHttpDraft(URL_DRAFT, URL_DRAFT.url, [
      { name: "Authorization", value: "Bearer first" },
      { name: "Authorization", value: "Bearer second" }
    ])

    expect(draft).toMatchObject({
      signIn: "token",
      token: "first",
      headers: [{ name: "Authorization", value: "Bearer second" }]
    })
  })

  it("signs in with nothing when no header carries a token, replacing the typed sign-in and rows", () => {
    const start = appendRows(TOKEN_DRAFT, "headers", [
      { name: "X-Old", value: "old" }
    ])

    expect(
      fillMcpHttpDraft(start, "https://mcp.example.test/other", [
        { name: "Authorization", value: "Basic xyz" }
      ])
    ).toMatchObject({
      url: "https://mcp.example.test/other",
      signIn: "none",
      token: "",
      headers: [{ name: "Authorization", value: "Basic xyz" }]
    })
  })

  it("returns a frozen draft with frozen rows", () => {
    const draft = fillMcpHttpDraft(URL_DRAFT, URL_DRAFT.url, [
      { name: "X-A", value: "1" }
    ])

    expect(Object.isFrozen(draft)).toBe(true)
    expect(Object.isFrozen(draft.headers)).toBe(true)
    expect(draft.headers.every((row) => Object.isFrozen(row))).toBe(true)
  })
})

describe("fillMcpStdioDraft", () => {
  it("writes the arguments on one line and numbers the variables from the next row identity, keeping the name and URL fields", () => {
    const start = appendRows(TOKEN_DRAFT, "headers", [
      { name: "X-A", value: "1" }
    ])
    const firstId = start.nextEntryId

    expect(
      fillMcpStdioDraft(
        start,
        "npx",
        ["-y", "two words", ""],
        [
          { name: "A", value: "1" },
          { name: "B", value: "" }
        ]
      )
    ).toEqual({
      ...start,
      transport: "stdio",
      command: "npx",
      argumentText: '-y "two words" ""',
      environment: [
        { id: firstId, name: "A", value: "1" },
        { id: firstId + 1, name: "B", value: "" }
      ],
      nextEntryId: firstId + 2
    })
  })

  it("returns a frozen draft with frozen rows", () => {
    const draft = fillMcpStdioDraft(
      COMMAND_DRAFT,
      "npx",
      [],
      [{ name: "A", value: "1" }]
    )

    expect(Object.isFrozen(draft)).toBe(true)
    expect(Object.isFrozen(draft.environment)).toBe(true)
    expect(draft.environment.every((row) => Object.isFrozen(row))).toBe(true)
  })
})

describe("buildMcpServerDraft", () => {
  it("writes a command server's arguments on one line and its variables as rows", () => {
    expect(buildMcpServerDraft(STORED_MCP_SETTINGS.servers[0])).toMatchObject({
      name: "files",
      transport: "stdio",
      command: "/opt/homebrew/bin/npx",
      argumentText: "-y @modelcontextprotocol/server-filesystem /tmp",
      environment: [{ name: "LOG_LEVEL", value: "debug" }],
      url: "",
      signIn: "none",
      token: "",
      headers: []
    })
  })

  it("reads a URL server's bearer header as the token", () => {
    expect(buildMcpServerDraft(STORED_MCP_SETTINGS.servers[1])).toMatchObject({
      name: "notes",
      transport: "http",
      command: "",
      argumentText: "",
      environment: [],
      url: "https://mcp.example.test/notes",
      signIn: "token",
      token: "fixture-0000",
      headers: []
    })
  })

  it("gives every row its own identity", () => {
    const draft = buildMcpServerDraft(
      mcpServerSettingsSchema.parse({
        name: "tools",
        transport: "stdio",
        command: "uvx",
        environment: [
          { name: "A", value: "1" },
          { name: "B", value: "2" },
          { name: "C", value: "3" }
        ]
      })
    )

    expect(new Set(draft.environment.map(({ id }) => id)).size).toBe(3)
  })

  it.each([
    [
      "a command server with an empty value, an = in a value, and arguments with spaces, quotes, and backslashes",
      {
        name: "tools",
        transport: "stdio",
        command: "uvx",
        arguments: [
          "--from",
          "two words",
          `say "hi"`,
          "it's",
          "C:\\tmp\\",
          " "
        ],
        environment: [
          { name: "EMPTY", value: "" },
          { name: "QUERY", value: "a=b" },
          { name: "PADDED", value: " spaced " }
        ]
      }
    ],
    [
      "a URL server with an empty header value, a : in a value, and an Authorization header of another scheme",
      {
        name: "web",
        transport: "http",
        url: "http://[::1]:8080/mcp",
        headers: [
          { name: "X-Empty", value: "" },
          { name: "X-Time", value: "12:30" },
          { name: "Authorization", value: "Basic xyz" }
        ]
      }
    ],
    [
      "a URL server whose bearer header comes first",
      {
        name: "web",
        transport: "http",
        url: "https://mcp.example.test",
        headers: [
          { name: "Authorization", value: "Bearer fixture-0000" },
          { name: "X-A", value: "1" }
        ]
      }
    ]
  ])("reads back %s as the same settings", (_case, candidate) => {
    const server = mcpServerSettingsSchema.parse(candidate)

    expect(
      parseMcpServerDraft(buildMcpServerDraft(server), NO_OTHER_NAMES)
    ).toEqual({ status: "valid", server })
  })

  it("reads back a bearer header as the first header, Authorization: Bearer <token>", () => {
    const server = mcpServerSettingsSchema.parse({
      name: "web",
      transport: "http",
      url: "https://mcp.example.test",
      headers: [
        { name: "X-A", value: "1" },
        { name: "authorization", value: "bearer fixture-0000" }
      ]
    })

    expect(
      parseMcpServerDraft(buildMcpServerDraft(server), NO_OTHER_NAMES)
    ).toMatchObject({
      status: "valid",
      server: {
        headers: [
          { name: "Authorization", value: "Bearer fixture-0000" },
          { name: "X-A", value: "1" }
        ]
      }
    })
  })

  it("returns a frozen draft", () => {
    expect(
      Object.isFrozen(buildMcpServerDraft(STORED_MCP_SETTINGS.servers[1]))
    ).toBe(true)
  })
})

describe("addMcpDraftEntry", () => {
  it("adds an empty row at the end of one list, leaving the other list and the draft as they were", () => {
    const start = appendRows(TOKEN_DRAFT, "headers", [
      { name: "X-A", value: "1" }
    ])

    const addition = addMcpDraftEntry(start, "headers")

    expect(addition.draft.headers).toEqual([
      ...start.headers,
      { id: addition.entryId, name: "", value: "" }
    ])
    expect(addition.draft.environment).toEqual(start.environment)
    expect(start.headers).toHaveLength(1)
    expect(Object.isFrozen(addition)).toBe(true)
    expect(Object.isFrozen(addition.draft)).toBe(true)
    expect(Object.isFrozen(addition.draft.headers)).toBe(true)
  })

  it("gives each new row an identity no other row of the draft has", () => {
    const start = buildMcpServerDraft(STORED_MCP_SETTINGS.servers[0])
    const first = addMcpDraftEntry(start, "environment")
    const second = addMcpDraftEntry(first.draft, "headers")
    const third = addMcpDraftEntry(second.draft, "environment")
    const ids = [
      ...third.draft.environment.map(({ id }) => id),
      ...third.draft.headers.map(({ id }) => id)
    ]

    expect(ids).toHaveLength(start.environment.length + 3)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("does not reuse the identity of a removed row", () => {
    const first = addMcpDraftEntry(COMMAND_DRAFT, "environment")
    const second = addMcpDraftEntry(first.draft, "environment")
    const removed = removeMcpDraftEntry(
      second.draft,
      "environment",
      second.entryId
    )

    const third = addMcpDraftEntry(removed, "environment")

    expect(third.entryId).not.toBe(second.entryId)
    expect(third.entryId).not.toBe(first.entryId)
  })
})

describe("updateMcpDraftEntry", () => {
  it("replaces the row with the same identity in place, keeping the others", () => {
    const start = appendRows(COMMAND_DRAFT, "environment", [
      { name: "A", value: "1" },
      { name: "B", value: "2" },
      { name: "C", value: "3" }
    ])
    const [first, second, third] = start.environment

    const draft = updateMcpDraftEntry(start, "environment", {
      id: second.id,
      name: "B2",
      value: "two"
    })

    expect(draft.environment).toEqual([
      first,
      { id: second.id, name: "B2", value: "two" },
      third
    ])
    expect(start.environment[1]).toEqual(second)
    expect(Object.isFrozen(draft)).toBe(true)
    expect(Object.isFrozen(draft.environment)).toBe(true)
    expect(Object.isFrozen(draft.environment[1])).toBe(true)
  })
})

describe("removeMcpDraftEntry", () => {
  it("removes the row with the identity, keeping the others in order", () => {
    const start = appendRows(URL_DRAFT, "headers", [
      { name: "X-A", value: "1" },
      { name: "X-B", value: "2" },
      { name: "X-C", value: "3" }
    ])
    const [first, second, third] = start.headers

    const draft = removeMcpDraftEntry(start, "headers", second.id)

    expect(draft.headers).toEqual([first, third])
    expect(start.headers).toHaveLength(3)
    expect(Object.isFrozen(draft)).toBe(true)
    expect(Object.isFrozen(draft.headers)).toBe(true)
  })
})

describe("isMcpServerDraftChanged", () => {
  /** URL draft with every text field and both lists filled. */
  const FILLED_DRAFT = appendRows(
    appendRows(TOKEN_DRAFT, "headers", [{ name: "X-A", value: "1" }]),
    "environment",
    [{ name: "A", value: "1" }]
  )

  it("is false for drafts built from the same server", () => {
    const server = STORED_MCP_SETTINGS.servers[0]

    expect(
      isMcpServerDraftChanged(
        buildMcpServerDraft(server),
        buildMcpServerDraft(server)
      )
    ).toBe(false)
  })

  it("is false after a row is added and removed again", () => {
    const addition = addMcpDraftEntry(FILLED_DRAFT, "environment")

    expect(
      isMcpServerDraftChanged(
        FILLED_DRAFT,
        removeMcpDraftEntry(addition.draft, "environment", addition.entryId)
      )
    ).toBe(false)
  })

  it("ignores row identities", () => {
    const addition = addMcpDraftEntry(COMMAND_DRAFT, "headers")
    const shifted = removeMcpDraftEntry(
      addition.draft,
      "headers",
      addition.entryId
    )
    const rows = [{ name: "A", value: "1" }]
    const initial = appendRows(COMMAND_DRAFT, "environment", rows)
    const draft = appendRows(shifted, "environment", rows)

    expect(draft.environment[0]?.id).not.toBe(initial.environment[0]?.id)
    expect(isMcpServerDraftChanged(initial, draft)).toBe(false)
  })

  it.each<[string, Partial<McpServerDraft>]>([
    ["name", { name: "other" }],
    ["transport", { transport: "stdio" }],
    ["command", { command: "npx" }],
    ["arguments", { argumentText: "-y" }],
    ["URL", { url: "https://mcp.example.test/other" }],
    ["sign-in", { signIn: "none" }],
    ["token", { token: "fixture-1111" }]
  ])("is true when the %s changes", (_field, change) => {
    expect(
      isMcpServerDraftChanged(FILLED_DRAFT, { ...FILLED_DRAFT, ...change })
    ).toBe(true)
  })

  it("is true when a row's name or value changes, or a row is removed", () => {
    const [header] = FILLED_DRAFT.headers
    const [variable] = FILLED_DRAFT.environment

    expect(
      isMcpServerDraftChanged(
        FILLED_DRAFT,
        updateMcpDraftEntry(FILLED_DRAFT, "headers", { ...header, value: "2" })
      )
    ).toBe(true)
    expect(
      isMcpServerDraftChanged(
        FILLED_DRAFT,
        updateMcpDraftEntry(FILLED_DRAFT, "environment", {
          ...variable,
          name: "B"
        })
      )
    ).toBe(true)
    expect(
      isMcpServerDraftChanged(
        FILLED_DRAFT,
        removeMcpDraftEntry(FILLED_DRAFT, "headers", header.id)
      )
    ).toBe(true)
  })
})

describe("parseMcpServerDraft", () => {
  it("reads a command draft as the shared settings, ignoring the URL fields", () => {
    const draft = appendRows(
      appendRows(
        { ...COMMAND_DRAFT, url: "not a url", signIn: "token", token: "" },
        "headers",
        [{ name: "bad name", value: "é" }]
      ),
      "environment",
      [{ name: "LOG_LEVEL", value: "debug" }]
    )

    const parse = parseMcpServerDraft(draft, NO_OTHER_NAMES)

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

  it("reads a URL draft as the shared settings, sending the token as the first header and ignoring the command fields", () => {
    const draft = appendRows(
      appendRows(
        { ...TOKEN_DRAFT, command: "", argumentText: '"open' },
        "environment",
        [{ name: "1BAD", value: "x" }]
      ),
      "headers",
      [{ name: "X-Api-Version", value: "2" }]
    )

    expect(parseMcpServerDraft(draft, NO_OTHER_NAMES)).toEqual({
      status: "valid",
      server: {
        name: "notes",
        transport: "http",
        url: "https://mcp.example.test/notes",
        headers: [
          { name: "Authorization", value: "Bearer fixture-0000" },
          { name: "X-Api-Version", value: "2" }
        ]
      }
    })
  })

  it("trims the name, command, and variable names, keeping a variable's value as typed", () => {
    const draft = appendRows(
      { ...COMMAND_DRAFT, name: "  files ", command: " npx\t" },
      "environment",
      [{ name: " LOG_LEVEL ", value: " debug " }]
    )

    expect(parseMcpServerDraft(draft, NO_OTHER_NAMES)).toMatchObject({
      status: "valid",
      server: {
        name: "files",
        command: "npx",
        environment: [{ name: "LOG_LEVEL", value: " debug " }]
      }
    })
  })

  it("trims the URL and header names, and header values and the token of spaces and tabs", () => {
    const draft = appendRows(
      {
        ...TOKEN_DRAFT,
        url: " https://mcp.example.test/notes ",
        token: " \tfixture-0000\t "
      },
      "headers",
      [{ name: " X-A ", value: "\t 1 \t" }]
    )

    expect(parseMcpServerDraft(draft, NO_OTHER_NAMES)).toMatchObject({
      status: "valid",
      server: {
        url: "https://mcp.example.test/notes",
        headers: [
          { name: "Authorization", value: "Bearer fixture-0000" },
          { name: "X-A", value: "1" }
        ]
      }
    })
  })

  it("reads the arguments line, keeping the spaces of a quoted argument", () => {
    expect(
      parseMcpServerDraft(
        { ...COMMAND_DRAFT, argumentText: `--from "two words" ' ' -v` },
        NO_OTHER_NAMES
      )
    ).toMatchObject({
      status: "valid",
      server: { arguments: ["--from", "two words", " ", "-v"] }
    })
  })

  it("skips rows with neither a name nor a value", () => {
    const commandDraft = appendRows(COMMAND_DRAFT, "environment", [
      BLANK_ROW,
      { name: "A", value: "1" },
      BLANK_ROW
    ])
    const urlDraft = appendRows(TOKEN_DRAFT, "headers", [
      BLANK_ROW,
      { name: "X-A", value: "1" }
    ])

    expect(parseMcpServerDraft(commandDraft, NO_OTHER_NAMES)).toMatchObject({
      status: "valid",
      server: { environment: [{ name: "A", value: "1" }] }
    })
    expect(parseMcpServerDraft(urlDraft, NO_OTHER_NAMES)).toMatchObject({
      status: "valid",
      server: {
        headers: [
          { name: "Authorization", value: "Bearer fixture-0000" },
          { name: "X-A", value: "1" }
        ]
      }
    })
  })

  it.each([
    ["a value but no name", { name: "", value: "x" }],
    ["a name of spaces", { name: "   ", value: "" }]
  ])("reports a variable row with %s", (_case, row) => {
    expect(
      readProblems(appendRows(COMMAND_DRAFT, "environment", [row]))
    ).toEqual({ environment: `Variable 1: ${VARIABLE_NAME_PROBLEM}` })
  })

  it("starts a row's problem with its position, counting skipped rows", () => {
    expect(
      readProblems(
        appendRows(COMMAND_DRAFT, "environment", [
          { name: "A", value: "1" },
          BLANK_ROW,
          { name: "1BAD", value: "x" }
        ])
      )
    ).toEqual({ environment: `Variable 3: ${VARIABLE_NAME_PROBLEM}` })
  })

  it("counts header positions among the rows, not the token", () => {
    expect(
      readProblems(
        appendRows(TOKEN_DRAFT, "headers", [
          BLANK_ROW,
          { name: "Content-Type", value: "application/json" }
        ])
      )
    ).toEqual({ headers: "Header 2: Lys sets this header itself." })
  })

  it("says where a quote is left open in the arguments", () => {
    expect(
      readProblems({ ...COMMAND_DRAFT, name: "", argumentText: '-y "abc' })
    ).toEqual({
      name: NAME_RULE_PROBLEM,
      arguments: "Close the quote at character 4."
    })
  })

  it("names an empty argument by its position", () => {
    expect(readProblems({ ...COMMAND_DRAFT, argumentText: '-y ""' })).toEqual({
      arguments: `Argument 2: An argument is 1 to ${MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH} characters.`
    })
  })

  it("names a long argument by its position and says how long it may be", () => {
    const problems = readProblems({
      ...COMMAND_DRAFT,
      argumentText: `-y ${"a".repeat(MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH + 1)}`
    })

    expect(problems.arguments).toMatch(
      new RegExp(
        `^Argument 2: An argument is 1 to ${MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH} characters`,
        "u"
      )
    )
  })

  it("names a variable whose value has a line break", () => {
    expect(
      readProblems(
        appendRows(COMMAND_DRAFT, "environment", [
          { name: "A", value: "line\nbreak" }
        ])
      )
    ).toEqual({
      environment: `Variable 1: A variable's value is up to ${MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH} characters, without line breaks or other control characters.`
    })
  })

  it.each([
    [
      "a name that is not a header name",
      { name: "X A", value: "1" },
      "Header 1: A header name is up to 128 letters, digits, and the characters !#$%&'*+.^_`|~-."
    ],
    [
      "a value outside visible ASCII",
      { name: "X-A", value: "café" },
      "Header 1: A header value is visible ASCII characters, spaces, and tabs, with no space or tab at either end."
    ],
    [
      "a value that is too long",
      { name: "X-A", value: "v".repeat(MAXIMUM_MCP_HEADER_VALUE_LENGTH + 1) },
      `Header 1: A header value is up to ${MAXIMUM_MCP_HEADER_VALUE_LENGTH} characters.`
    ]
  ])("names a header row with %s", (_case, row, problem) => {
    expect(readProblems(appendRows(URL_DRAFT, "headers", [row]))).toEqual({
      headers: problem
    })
  })

  it("refuses a variable set twice and a header sent twice ignoring case", () => {
    expect(
      readProblems(
        appendRows(COMMAND_DRAFT, "environment", [
          { name: "A", value: "1" },
          { name: "A", value: "2" }
        ])
      )
    ).toEqual({ environment: "A server sets each environment variable once." })
    expect(
      readProblems(
        appendRows(URL_DRAFT, "headers", [
          { name: "X-A", value: "1" },
          { name: "x-a", value: "2" }
        ])
      )
    ).toEqual({ headers: "A server is sent each header once." })
  })

  it("says how many arguments and variables a server may have", () => {
    expect(
      readProblems({
        ...COMMAND_DRAFT,
        argumentText: Array.from(
          { length: MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT + 1 },
          () => "-v"
        ).join(" ")
      })
    ).toEqual({
      arguments: `A server takes at most ${MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT} arguments.`
    })
    expect(
      readProblems(
        appendRows(
          COMMAND_DRAFT,
          "environment",
          Array.from(
            { length: MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT + 1 },
            (_, index) => ({ name: `V${index}`, value: "v" })
          )
        )
      )
    ).toEqual({
      environment: `A server sets at most ${MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT} environment variables.`
    })
  })

  it.each([
    ["header rows alone", URL_DRAFT, MAXIMUM_MCP_HEADER_COUNT],
    ["header rows and the token", TOKEN_DRAFT, MAXIMUM_MCP_HEADER_COUNT - 1]
  ])(
    "accepts as many headers as a server may be sent, counting %s",
    (_case, start, rowCount) => {
      expect(
        parseMcpServerDraft(
          appendRows(start, "headers", buildHeaderRows(rowCount)),
          NO_OTHER_NAMES
        ).status
      ).toBe("valid")
    }
  )

  it.each([
    ["header rows alone", URL_DRAFT, MAXIMUM_MCP_HEADER_COUNT + 1],
    ["header rows and the token", TOKEN_DRAFT, MAXIMUM_MCP_HEADER_COUNT]
  ])(
    "says how many headers a server may be sent, counting %s",
    (_case, start, rowCount) => {
      expect(
        readProblems(appendRows(start, "headers", buildHeaderRows(rowCount)))
      ).toEqual({
        headers: `A server is sent at most ${MAXIMUM_MCP_HEADER_COUNT} headers, the token's included.`
      })
    }
  )

  it.each([
    ["empty", ""],
    ["only spaces and tabs", " \t "]
  ])(
    "asks for the token when signing in with one that is %s",
    (_case, token) => {
      expect(readProblems({ ...TOKEN_DRAFT, token })).toEqual({
        token: EMPTY_TOKEN_PROBLEM
      })
    }
  )

  it.each([
    ["a character outside ASCII", "fixture-ö"],
    ["a line break", "fixture\n0000"]
  ])("refuses a token with %s", (_case, token) => {
    expect(readProblems({ ...TOKEN_DRAFT, token })).toEqual({
      token: TOKEN_FORMAT_PROBLEM
    })
  })

  it("accepts a token as long as a header value allows, and says how long it may be past that", () => {
    expect(
      parseMcpServerDraft(
        { ...TOKEN_DRAFT, token: "t".repeat(MAXIMUM_TOKEN_LENGTH) },
        NO_OTHER_NAMES
      ).status
    ).toBe("valid")
    expect(
      readProblems({
        ...TOKEN_DRAFT,
        token: "t".repeat(MAXIMUM_TOKEN_LENGTH + 1)
      })
    ).toEqual({ token: `A token is up to ${MAXIMUM_TOKEN_LENGTH} characters.` })
  })

  it.each(["Authorization", " authorization "])(
    "refuses an Authorization header row named %j beside a token",
    (name) => {
      expect(
        readProblems(
          appendRows(TOKEN_DRAFT, "headers", [{ name, value: "Basic xyz" }])
        )
      ).toEqual({ headers: AUTHORIZATION_HEADER_PROBLEM })
    }
  )

  it("reports an empty token and an Authorization header row together", () => {
    expect(
      readProblems(
        appendRows({ ...TOKEN_DRAFT, token: "" }, "headers", [
          { name: "Authorization", value: "Basic xyz" }
        ])
      )
    ).toEqual({
      token: EMPTY_TOKEN_PROBLEM,
      headers: AUTHORIZATION_HEADER_PROBLEM
    })
  })

  it("sends an Authorization header row as it is without sign-in, ignoring a typed token", () => {
    const draft = appendRows(
      { ...URL_DRAFT, signIn: "none", token: "fixture-ö" },
      "headers",
      [{ name: "Authorization", value: "Basic xyz" }]
    )

    expect(parseMcpServerDraft(draft, NO_OTHER_NAMES)).toMatchObject({
      status: "valid",
      server: { headers: [{ name: "Authorization", value: "Basic xyz" }] }
    })
  })

  it("says each empty required field needs a value", () => {
    expect(readProblems({ ...COMMAND_DRAFT, command: "" })).toEqual({
      command: `Enter the command that starts the server, up to ${MAXIMUM_MCP_COMMAND_LENGTH} characters.`
    })
    expect(readProblems(buildEmptyMcpServerDraft("http"))).toEqual({
      name: NAME_RULE_PROBLEM,
      url: URL_RULE_PROBLEM
    })
  })

  it("gives the schema's sentence for a name that breaks the name rule", () => {
    expect(readProblems({ ...COMMAND_DRAFT, name: "My Files" })).toEqual({
      name: NAME_RULE_PROBLEM
    })
  })

  it("says how long a name may be", () => {
    expect(
      readProblems({
        ...COMMAND_DRAFT,
        name: "a".repeat(MAXIMUM_MCP_SERVER_NAME_LENGTH + 1)
      })
    ).toEqual({
      name: `An MCP server name is up to ${MAXIMUM_MCP_SERVER_NAME_LENGTH} characters.`
    })
  })

  it("refuses a name another saved server has, once trimmed", () => {
    expect(
      readProblems({ ...COMMAND_DRAFT, name: " files " }, new Set(["files"]))
    ).toEqual({ name: DUPLICATE_NAME_PROBLEM })
  })

  it("reports a taken name beside the other fields' problems", () => {
    expect(
      readProblems({ ...COMMAND_DRAFT, command: "" }, new Set(["files"]))
    ).toEqual({
      name: DUPLICATE_NAME_PROBLEM,
      command: `Enter the command that starts the server, up to ${MAXIMUM_MCP_COMMAND_LENGTH} characters.`
    })
  })

  it("prefers the name rule to the taken name", () => {
    expect(
      readProblems({ ...COMMAND_DRAFT, name: "Files" }, new Set(["Files"]))
    ).toEqual({ name: NAME_RULE_PROBLEM })
  })

  it("refuses a URL that is not https or loopback http", () => {
    expect(
      readProblems({ ...URL_DRAFT, url: "http://mcp.example.test" })
    ).toEqual({ url: URL_RULE_PROBLEM })
  })

  it("reports the first problem of each field at once", () => {
    expect(
      readProblems(
        appendRows(
          { ...COMMAND_DRAFT, name: "", command: "", argumentText: "'open" },
          "environment",
          [
            { name: "1BAD", value: "x" },
            { name: "2BAD", value: "y" }
          ]
        )
      )
    ).toEqual({
      name: NAME_RULE_PROBLEM,
      command: `Enter the command that starts the server, up to ${MAXIMUM_MCP_COMMAND_LENGTH} characters.`,
      arguments: "Close the quote at character 1.",
      environment: `Variable 1: ${VARIABLE_NAME_PROBLEM}`
    })
  })

  it("returns frozen problems", () => {
    const parse = parseMcpServerDraft(
      buildEmptyMcpServerDraft("stdio"),
      NO_OTHER_NAMES
    )

    expect(Object.isFrozen(parse)).toBe(true)
    expect(parse.status === "invalid" && Object.isFrozen(parse.problems)).toBe(
      true
    )
  })
})
