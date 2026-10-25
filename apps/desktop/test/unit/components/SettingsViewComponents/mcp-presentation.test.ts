import type {
  McpServerFailure,
  McpServerState,
  McpServerStatus,
  SkippedMcpToolReason
} from "@lys/protocol"
import {
  mcpServerSettingsSchema,
  type McpServerSettings,
  type McpServerSettingsCandidate,
  type ToolDefinition
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  canAddMcpServer,
  countConnectedMcpServers,
  findMcpPaneRetry,
  findMcpServerApproval,
  findMcpServerStatus,
  formatMcpDraftFieldLabel,
  formatMcpDraftProblemSummaryHeading,
  formatMcpEditorHint,
  formatMcpEditorKind,
  formatMcpReconnectLabel,
  formatMcpServerApprovalNote,
  formatMcpServerJsonMessage,
  formatMcpServerListMeta,
  formatMcpServerRemovalQuestion,
  formatMcpServerStatus,
  formatMcpServerTarget,
  formatMcpServerToolCount,
  formatMcpServerToolMeta,
  formatMcpServerToolsNote,
  formatMcpSettingsOutcome,
  formatMcpSignInLabel,
  formatMcpSignInNote,
  formatMcpToolNamePreview,
  formatMcpToolOfferWarning,
  formatSkippedMcpToolName,
  formatSkippedMcpToolReason,
  getMcpEntryListPresentation,
  getMcpTransportPresentation,
  listMcpDraftProblems,
  listMcpPaneNotes,
  listMcpServerConfiguration,
  listMcpServerTools,
  listSkippedMcpTools,
  MCP_BACKEND_STOPPED_NOTE,
  MCP_EMPTY_LIST_NOTE,
  MCP_SERVER_JSON_HINT,
  MCP_SERVER_LIMIT_NOTE,
  MCP_SERVER_NAME_RULE,
  MCP_SERVER_TRANSPORTS,
  MCP_TOOL_CHIPS_NOTE,
  MCP_TOOL_LIST_CUT_NOTE,
  type McpPaneFacts,
  type McpServerRowFacts
} from "@/components/SettingsViewComponents/mcp-presentation"
import {
  calculateToolTokenEstimate,
  formatToolTokenEstimate
} from "@/components/SettingsViewComponents/tool-presentation"
import {
  buildEmptyMcpServerDraft,
  fillMcpStdioDraft,
  MCP_SERVER_DRAFT_FIELDS,
  MCP_SIGN_INS
} from "@/lib/models/mcp-server-draft"
import type { McpServerJsonParse } from "@/lib/models/mcp-server-json"
import type { ToolModelSupport } from "@/lib/models/tool-model-support"
import type { McpServerListState } from "@/lib/store/mcp-servers"
import type { ToolListState } from "@/lib/store/tools"
import {
  buildConnectedMcpState,
  buildFailedMcpState,
  buildMcpServerList,
  buildMcpServerStatus,
  CONNECTING_MCP_STATE
} from "../../support/mcpFixtures"
import { STORED_MCP_SETTINGS } from "../../support/settingsFixtures"
import {
  buildBackendToolDefinition,
  buildMcpToolDefinition,
  buildToolDefinition
} from "../../support/toolFixtures"

/**
 * Validates server settings with the shared schema, as the settings store
 * holds them.
 *
 * @param candidate - Server settings as written in the `mcp` group.
 * @returns The frozen settings the shared schema returns.
 */
function parseMcpServer(
  candidate: McpServerSettingsCandidate
): McpServerSettings {
  return mcpServerSettingsSchema.parse(candidate)
}

/**
 * Builds a loaded list of applied servers whose last read applied the group.
 *
 * @param servers - Applied servers in the group's order.
 * @returns The list state, validated by the shared list schema.
 */
function buildLoadedMcpList(
  servers: readonly McpServerStatus[]
): McpServerListState {
  return { status: "loaded", ...buildMcpServerList(servers) }
}

/**
 * Builds the facts of a saved server the running backend applied.
 *
 * @param server - Saved settings of the server.
 * @param state - State the backend reports for it.
 * @returns Facts whose loaded list holds only that server.
 */
function buildAppliedRowFacts(
  server: McpServerSettings,
  state: McpServerState
): McpServerRowFacts {
  const status = buildMcpServerStatus(server.name, server.transport, state)
  return {
    isBackendRunning: true,
    list: buildLoadedMcpList([status]),
    server
  }
}

/**
 * Builds a loaded tool list in which every tool can run now.
 *
 * @param tools - Every listed tool, in list order.
 * @returns The list state.
 */
function buildLoadedToolList(tools: readonly ToolDefinition[]): ToolListState {
  return { status: "loaded", tools, unavailableTools: new Map() }
}

/**
 * Builds the outcome of a paste that filled the editor with a command
 * server.
 *
 * @param name - Name the draft holds after the paste; empty when the config
 * gave none and none was typed.
 * @param serverCount - Number of servers the pasted config holds.
 * @returns The filled outcome.
 */
function buildFilledJsonParse(
  name: string,
  serverCount: number
): McpServerJsonParse {
  const named = Object.freeze({ ...buildEmptyMcpServerDraft("stdio"), name })
  return {
    status: "filled",
    draft: fillMcpStdioDraft(named, "npx", ["-y", "server-github"], []),
    serverCount
  }
}

/**
 * Command server with arguments and two variables; the token variable's
 * value stands in for a secret.
 */
const COMMAND_SERVER = parseMcpServer({
  name: "github",
  transport: "stdio",
  command: "npx",
  arguments: ["-y", "@modelcontextprotocol/server-github"],
  environment: [
    { name: "GITHUB_TOKEN", value: "fixture-env-secret" },
    { name: "LOG_LEVEL", value: "debug" }
  ]
})

/**
 * URL server with another header before its bearer token; both values stand
 * in for secrets.
 */
const URL_SERVER = parseMcpServer({
  name: "notes",
  transport: "http",
  url: "https://mcp.example.test/notes",
  headers: [
    { name: "X-Workspace", value: "fixture-header-secret" },
    { name: "Authorization", value: "Bearer fixture-token-secret" }
  ]
})

/** Command server without arguments or variables. */
const BARE_COMMAND_SERVER = parseMcpServer({
  name: "bare",
  transport: "stdio",
  command: "/usr/local/bin/bare"
})

/** URL server on this machine, without a token or headers. */
const OPEN_URL_SERVER = parseMcpServer({
  name: "local",
  transport: "http",
  url: "http://localhost:3845/mcp"
})

/** Two tools of the command server whose token estimates differ. */
const GITHUB_SEARCH = buildMcpToolDefinition("github", "search")
const GITHUB_ISSUES = buildMcpToolDefinition("github", "issues", {
  type: "object",
  properties: {}
})

/** Tool of the URL server with the same server tool name as one of github's. */
const NOTES_SEARCH = buildMcpToolDefinition("notes", "search")

/** Tool of a server whose name starts with the command server's name. */
const ARCHIVE_FIND = buildMcpToolDefinition("github-archive", "find")

/** Loaded list with the stored command server connected. */
const LOADED_LIST: McpServerListState = buildLoadedMcpList([
  buildMcpServerStatus("files", "stdio", buildConnectedMcpState(2))
])

/** Facts of a pane with nothing to say. */
const QUIET_FACTS: McpPaneFacts = Object.freeze<McpPaneFacts>({
  isBackendRunning: true,
  list: LOADED_LIST,
  actionFailure: null,
  saveState: { status: "idle" },
  isEditing: false
})

/** Failed save as the application store reports it. */
const FAILED_SAVE = Object.freeze({
  status: "failed",
  error: "Lys couldn't write the MCP servers to its settings file."
} as const)

describe("transports", () => {
  it("offers a local program first, then a remote server, each with what Lys does with it", () => {
    expect(MCP_SERVER_TRANSPORTS).toEqual(["stdio", "http"])
    expect(MCP_SERVER_TRANSPORTS.map(getMcpTransportPresentation)).toEqual([
      {
        tag: "stdio",
        name: "Local program",
        blurb:
          "Lys starts it on this machine and talks to it over stdin and stdout. It stops when Lys does.",
        example: "npx -y @modelcontextprotocol/server-github"
      },
      {
        tag: "http",
        name: "Remote server",
        blurb:
          "Lys reaches it at a URL. It runs wherever it is hosted and may need a token.",
        example: "https://mcp.example.com/mcp"
      }
    ])
  })
})

describe("formatMcpServerTarget", () => {
  it("shows a command with its arguments, never its environment", () => {
    expect(formatMcpServerTarget(STORED_MCP_SETTINGS.servers[0])).toBe(
      "/opt/homebrew/bin/npx -y @modelcontextprotocol/server-filesystem /tmp"
    )
  })

  it("shows a command without arguments alone", () => {
    expect(formatMcpServerTarget(BARE_COMMAND_SERVER)).toBe(
      "/usr/local/bin/bare"
    )
  })

  it("quotes an argument that holds a space or a quote, so it reads as one", () => {
    const server = parseMcpServer({
      name: "spaced",
      transport: "stdio",
      command: "uvx",
      arguments: ["--root", "/Users/me/My Files", 'say "hi"']
    })

    expect(formatMcpServerTarget(server)).toBe(
      'uvx --root "/Users/me/My Files" "say \\"hi\\""'
    )
  })

  it("shows a URL, never its headers", () => {
    expect(formatMcpServerTarget(URL_SERVER)).toBe(
      "https://mcp.example.test/notes"
    )
  })
})

describe("findMcpServerStatus", () => {
  it("finds an applied server by name, and nothing in a list not loaded", () => {
    expect(findMcpServerStatus(LOADED_LIST, "files")).toEqual(
      buildMcpServerStatus("files", "stdio", buildConnectedMcpState(2))
    )
    expect(findMcpServerStatus(LOADED_LIST, "notes")).toBeUndefined()
    expect(findMcpServerStatus({ status: "idle" }, "files")).toBeUndefined()
  })
})

describe("formatMcpServerStatus", () => {
  it("says a server is not connected while the backend is not running, whatever a list read before says", () => {
    expect(
      formatMcpServerStatus({
        ...buildAppliedRowFacts(COMMAND_SERVER, buildConnectedMcpState(2)),
        isBackendRunning: false
      })
    ).toEqual({
      condition: "idle",
      chip: "",
      heading: "Not connected",
      detail: "Lys connects once the backend runs."
    })
  })

  it.each([
    ["not read yet", { status: "idle" }, "Reading the server states…"],
    ["being read", { status: "loading" }, "Reading the server states…"],
    [
      "unreadable",
      { status: "failed", error: "Unreachable." },
      "Lys couldn't read the server states."
    ]
  ] as const)(
    "says the state is unknown while the list is %s",
    (_, list, detail) => {
      expect(
        formatMcpServerStatus({
          isBackendRunning: true,
          list,
          server: COMMAND_SERVER
        })
      ).toEqual({
        condition: "idle",
        chip: "",
        heading: "State unknown",
        detail
      })
    }
  )

  it.each([
    { server: COMMAND_SERVER, button: "Start" },
    { server: URL_SERVER, button: "Connect" }
  ])(
    "says a saved $server.transport server the backend did not apply is not applied, naming its $button button",
    ({ server, button }) => {
      expect(
        formatMcpServerStatus({
          isBackendRunning: true,
          list: LOADED_LIST,
          server
        })
      ).toEqual({
        condition: "idle",
        chip: "not applied",
        heading: "Not applied",
        detail: `${button} applies the saved servers.`
      })
      expect(formatMcpReconnectLabel(server.transport, "idle")).toBe(button)
    }
  )

  it("says a local program is starting", () => {
    expect(
      formatMcpServerStatus(
        buildAppliedRowFacts(COMMAND_SERVER, CONNECTING_MCP_STATE)
      )
    ).toEqual({
      condition: "connecting",
      chip: "starting",
      heading: "Starting",
      detail: "started · waiting for initialize"
    })
  })

  it.each([
    [URL_SERVER, "waiting for initialize from mcp.example.test"],
    [OPEN_URL_SERVER, "waiting for initialize from localhost:3845"]
  ])(
    "says a remote server is connecting, naming its host and port",
    (server, detail) => {
      expect(
        formatMcpServerStatus(
          buildAppliedRowFacts(server, CONNECTING_MCP_STATE)
        )
      ).toEqual({
        condition: "connecting",
        chip: "connecting",
        heading: "Connecting",
        detail
      })
    }
  )

  it.each([
    [
      "local program",
      COMMAND_SERVER,
      buildConnectedMcpState(3),
      "Running",
      "3 tools listed"
    ],
    [
      "remote server",
      URL_SERVER,
      buildConnectedMcpState(1),
      "Connected",
      "1 tool listed"
    ],
    [
      "remote server",
      URL_SERVER,
      buildConnectedMcpState(0),
      "Connected",
      "0 tools listed"
    ],
    [
      "local program",
      COMMAND_SERVER,
      buildConnectedMcpState(4, [
        { name: "a", reason: "unsupported-name" },
        { name: "b", reason: "duplicate-name" }
      ]),
      "Running",
      "4 tools listed · 2 skipped"
    ]
  ])(
    "says a connected %s is %s and counts its tools: %s",
    (_, server, state, heading, detail) => {
      expect(
        formatMcpServerStatus(buildAppliedRowFacts(server, state))
      ).toEqual({ condition: "connected", chip: "", heading, detail })
    }
  )

  it.each([
    [
      "start-failed",
      "Lys couldn't start the command. Check that it exists; use its full path."
    ],
    ["closed", "The server closed the connection."],
    ["timed-out", "The server didn't answer within 2 minutes."],
    [
      "unauthorized",
      "The server refused the request. Check the token and the headers."
    ],
    ["unreachable", "Lys couldn't reach the server."],
    ["http-error", "The server answered with an HTTP error."],
    ["protocol-error", "The server's answer isn't valid MCP."]
  ] as const)(
    "says why a server failed: %s",
    (reason: McpServerFailure, detail) => {
      expect(
        formatMcpServerStatus(
          buildAppliedRowFacts(URL_SERVER, buildFailedMcpState(reason))
        )
      ).toEqual({
        condition: "failed",
        chip: "failed",
        heading: "Failed",
        detail
      })
    }
  )
})

describe("formatMcpReconnectLabel", () => {
  it.each([
    ["stdio", "failed", "Retry"],
    ["http", "failed", "Retry"],
    ["stdio", "idle", "Start"],
    ["http", "idle", "Connect"],
    ["stdio", "connected", "Restart"],
    ["http", "connected", "Reconnect"],
    ["stdio", "connecting", "Restart"],
    ["http", "connecting", "Reconnect"]
  ] as const)(
    "labels the button of a %s server that is %s: %s",
    (transport, condition, label) => {
      expect(formatMcpReconnectLabel(transport, condition)).toBe(label)
    }
  )
})

describe("listMcpServerTools", () => {
  /** Lys's tools, then the tools of three servers, interleaved. */
  const toolList = buildLoadedToolList([
    buildToolDefinition("read_text_file"),
    buildBackendToolDefinition("web_search"),
    GITHUB_SEARCH,
    NOTES_SEARCH,
    ARCHIVE_FIND,
    GITHUB_ISSUES
  ])

  it("lists only a connected server's own tools, in the backend's order", () => {
    expect(listMcpServerTools(toolList, "github", "connected")).toEqual([
      GITHUB_SEARCH,
      GITHUB_ISSUES
    ])
  })

  it.each(["connecting", "failed", "idle"] as const)(
    "lists no tool of a server that is %s, even when the list still holds its tools",
    (condition) => {
      expect(listMcpServerTools(toolList, "github", condition)).toEqual([])
    }
  )

  it.each([
    [{ status: "idle" }],
    [{ status: "loading" }],
    [{ status: "failed", error: "Lys couldn't read the tools." }]
  ] as const)("lists no tool while the tool list is %o", (unreadList) => {
    expect(listMcpServerTools(unreadList, "github", "connected")).toEqual([])
  })
})

describe("formatMcpServerToolCount", () => {
  it.each([
    [3, 3, "3 tools"],
    [1, 1, "1 tool"],
    [2, 3, "2 of 3 tools"],
    [0, 2, "0 of 2 tools"],
    [0, 0, ""]
  ])("counts %i on of %i listed tools as %j", (onCount, toolCount, text) => {
    expect(formatMcpServerToolCount(onCount, toolCount)).toBe(text)
  })
})

describe("formatMcpServerToolMeta", () => {
  it("counts every tool on until switched off, with their summed estimate", () => {
    const estimate =
      calculateToolTokenEstimate(GITHUB_SEARCH) +
      calculateToolTokenEstimate(GITHUB_ISSUES)

    expect(
      formatMcpServerToolMeta([GITHUB_SEARCH, GITHUB_ISSUES], new Map())
    ).toBe(`2 of 2 on · ${formatToolTokenEstimate(estimate)}`)
  })

  it("leaves a switched-off tool out of the count and the estimate", () => {
    const toolSwitches = new Map([
      [GITHUB_SEARCH.name, false],
      [GITHUB_ISSUES.name, true]
    ])

    expect(
      formatMcpServerToolMeta([GITHUB_SEARCH, GITHUB_ISSUES], toolSwitches)
    ).toBe(
      `1 of 2 on · ${formatToolTokenEstimate(calculateToolTokenEstimate(GITHUB_ISSUES))}`
    )
  })

  it("estimates nothing while every tool is off", () => {
    const toolSwitches = new Map([
      [GITHUB_SEARCH.name, false],
      [GITHUB_ISSUES.name, false]
    ])

    expect(
      formatMcpServerToolMeta([GITHUB_SEARCH, GITHUB_ISSUES], toolSwitches)
    ).toBe("0 of 2 on · ~0 tok")
  })
})

describe("formatMcpServerToolsNote", () => {
  /** Tool list read without any tool of the server. */
  const loadedToolList = buildLoadedToolList([NOTES_SEARCH])

  it.each([
    [
      "failed",
      "It stopped before listing any tools. Fix the cause above, then retry."
    ],
    ["connecting", "Listing tools…"],
    ["idle", "No tools seen yet. They show up once it connects."]
  ] as const)(
    "says why a server that is %s shows no tool",
    (condition, text) => {
      expect(
        formatMcpServerToolsNote({
          condition,
          toolList: loadedToolList,
          skippedToolCount: 0
        })
      ).toBe(text)
    }
  )

  it("shows why the tool list could not be read for a connected server", () => {
    expect(
      formatMcpServerToolsNote({
        condition: "connected",
        toolList: { status: "failed", error: "Lys couldn't read the tools." },
        skippedToolCount: 0
      })
    ).toBe("Lys couldn't read the tools.")
  })

  it.each([[{ status: "idle" }], [{ status: "loading" }]] as const)(
    "says a connected server's tools are being listed while the tool list is %o",
    (toolList) => {
      expect(
        formatMcpServerToolsNote({
          condition: "connected",
          toolList,
          skippedToolCount: 0
        })
      ).toBe("Listing tools…")
    }
  )

  it("tells a connected server that lists no tools from one whose every tool was skipped", () => {
    expect(
      formatMcpServerToolsNote({
        condition: "connected",
        toolList: loadedToolList,
        skippedToolCount: 0
      })
    ).toBe("It lists no tools.")
    expect(
      formatMcpServerToolsNote({
        condition: "connected",
        toolList: loadedToolList,
        skippedToolCount: 2
      })
    ).toBe("It lists no tool Lys can offer.")
  })
})

describe("server approval", () => {
  it("finds none while the server lists no tool", () => {
    expect(findMcpServerApproval([], new Set([GITHUB_SEARCH.name]))).toBe(
      "none"
    )
  })

  it("finds the approval every tool shares", () => {
    const tools = [GITHUB_SEARCH, GITHUB_ISSUES]

    expect(findMcpServerApproval(tools, new Set())).toBe("ask")
    expect(
      findMcpServerApproval(
        tools,
        new Set([GITHUB_SEARCH.name, GITHUB_ISSUES.name])
      )
    ).toBe("run")
  })

  it("finds the tools mixed when only some are on Just run", () => {
    expect(
      findMcpServerApproval(
        [GITHUB_SEARCH, GITHUB_ISSUES],
        new Set([GITHUB_ISSUES.name])
      )
    ).toBe("mixed")
  })

  it("reads each tool's approval by its full name, not by the server's name for it", () => {
    expect(
      findMcpServerApproval([GITHUB_SEARCH], new Set([NOTES_SEARCH.name]))
    ).toBe("ask")
  })

  it.each([
    [
      "ask",
      "You see each call and its arguments first. Nothing runs until you say yes."
    ],
    [
      "run",
      "Its tools run the moment the model asks. Only for servers you trust."
    ],
    [
      "mixed",
      "Some of its tools ask first and some run at once. Choose one for all of them."
    ],
    [
      "none",
      "Each of its tools asks first. You can choose here once it lists them."
    ]
  ] as const)("says what %s means for its calls", (approval, note) => {
    expect(formatMcpServerApprovalNote(approval)).toBe(note)
  })
})

describe("listMcpServerConfiguration", () => {
  it("lists a local program's transport, command, arguments, and the names of its variables, never their values", () => {
    const lines = listMcpServerConfiguration(COMMAND_SERVER)

    expect(lines).toEqual([
      {
        label: "transport",
        value: "stdio · child process of Lys",
        isNone: false
      },
      { label: "command", value: "npx", isNone: false },
      {
        label: "arguments",
        value: "-y @modelcontextprotocol/server-github",
        isNone: false
      },
      { label: "environment", value: "GITHUB_TOKEN, LOG_LEVEL", isNone: false }
    ])
    expect(JSON.stringify(lines)).not.toContain("fixture-env-secret")
    expect(Object.isFrozen(lines)).toBe(true)
  })

  it("says none for a local program without arguments or variables", () => {
    expect(listMcpServerConfiguration(BARE_COMMAND_SERVER)).toEqual([
      {
        label: "transport",
        value: "stdio · child process of Lys",
        isNone: false
      },
      { label: "command", value: "/usr/local/bin/bare", isNone: false },
      { label: "arguments", value: "none", isNone: true },
      { label: "environment", value: "none", isNone: true }
    ])
  })

  it("lists a remote server's bearer token as its sign-in and its other headers by name, never a value", () => {
    const lines = listMcpServerConfiguration(URL_SERVER)

    expect(lines).toEqual([
      { label: "transport", value: "streamable http", isNone: false },
      {
        label: "url",
        value: "https://mcp.example.test/notes",
        isNone: false
      },
      { label: "sign-in", value: "bearer token", isNone: false },
      { label: "headers", value: "X-Workspace", isNone: false }
    ])
    expect(JSON.stringify(lines)).not.toContain("fixture-token-secret")
    expect(JSON.stringify(lines)).not.toContain("fixture-header-secret")
    expect(Object.isFrozen(lines)).toBe(true)
  })

  it("says none for a remote server without a token or headers", () => {
    expect(listMcpServerConfiguration(OPEN_URL_SERVER)).toEqual([
      { label: "transport", value: "streamable http", isNone: false },
      { label: "url", value: "http://localhost:3845/mcp", isNone: false },
      { label: "sign-in", value: "none", isNone: true },
      { label: "headers", value: "none", isNone: true }
    ])
  })

  it("lists an Authorization header that holds no bearer token as a header, never its value", () => {
    const server = parseMcpServer({
      name: "basic",
      transport: "http",
      url: "https://mcp.example.test/basic",
      headers: [{ name: "Authorization", value: "Basic fixture-basic-secret" }]
    })
    const lines = listMcpServerConfiguration(server)

    expect(lines.slice(2)).toEqual([
      { label: "sign-in", value: "none", isNone: true },
      { label: "headers", value: "Authorization", isNone: false }
    ])
    expect(JSON.stringify(lines)).not.toContain("fixture-basic-secret")
  })
})

describe("formatMcpServerRemovalQuestion", () => {
  it.each([
    [
      "a local program with variables",
      COMMAND_SERVER,
      "remove github and its secrets?"
    ],
    [
      "a remote server with headers",
      URL_SERVER,
      "remove notes and its secrets?"
    ],
    [
      "a remote server with only a token",
      STORED_MCP_SETTINGS.servers[1],
      "remove notes and its secrets?"
    ],
    ["a local program without variables", BARE_COMMAND_SERVER, "remove bare?"],
    ["a remote server without headers", OPEN_URL_SERVER, "remove local?"]
  ])("asks before removing %s", (_, server, question) => {
    expect(formatMcpServerRemovalQuestion(server)).toBe(question)
  })
})

describe("countConnectedMcpServers", () => {
  /** Saved servers in list order. */
  const servers = [
    COMMAND_SERVER,
    URL_SERVER,
    OPEN_URL_SERVER,
    BARE_COMMAND_SERVER
  ]

  /** Applied servers: one saved server per state, one no longer saved. */
  const list = buildLoadedMcpList([
    buildMcpServerStatus("github", "stdio", buildConnectedMcpState(2)),
    buildMcpServerStatus("notes", "http", CONNECTING_MCP_STATE),
    buildMcpServerStatus("local", "http", buildFailedMcpState("unreachable")),
    buildMcpServerStatus("old", "stdio", buildConnectedMcpState(1))
  ])

  it("counts only the saved servers the backend reports connected", () => {
    expect(countConnectedMcpServers(servers, list, true)).toBe(1)
  })

  it("counts nothing while the backend is not running, whatever a list read before says", () => {
    expect(countConnectedMcpServers(servers, list, false)).toBeUndefined()
  })

  it.each([
    [{ status: "idle" }],
    [{ status: "loading" }],
    [{ status: "failed", error: "Unreachable." }]
  ] as const)("counts nothing while the list is %o", (unreadList) => {
    expect(countConnectedMcpServers(servers, unreadList, true)).toBeUndefined()
  })
})

describe("formatMcpServerListMeta", () => {
  it("says none yet without servers", () => {
    expect(
      formatMcpServerListMeta({
        serverCount: 0,
        connectedCount: 0,
        connectedTools: [],
        toolSwitches: new Map()
      })
    ).toBe("none yet")
  })

  it("counts the saved servers while their states are not known", () => {
    expect(
      formatMcpServerListMeta({
        serverCount: 2,
        connectedCount: undefined,
        connectedTools: undefined,
        toolSwitches: new Map()
      })
    ).toBe("2 saved")
  })

  it("counts the connected servers alone while the tools are not read", () => {
    expect(
      formatMcpServerListMeta({
        serverCount: 2,
        connectedCount: 1,
        connectedTools: undefined,
        toolSwitches: new Map()
      })
    ).toBe("1 of 2 connected")
  })

  it("adds the connected tools that are on and their estimate per request", () => {
    const estimate =
      calculateToolTokenEstimate(GITHUB_ISSUES) +
      calculateToolTokenEstimate(NOTES_SEARCH)

    expect(
      formatMcpServerListMeta({
        serverCount: 3,
        connectedCount: 2,
        connectedTools: [GITHUB_SEARCH, GITHUB_ISSUES, NOTES_SEARCH],
        toolSwitches: new Map([[GITHUB_SEARCH.name, false]])
      })
    ).toBe(
      `2 of 3 connected · 2 tools · ${formatToolTokenEstimate(estimate)} per request`
    )
  })

  it("counts one tool in the singular", () => {
    expect(
      formatMcpServerListMeta({
        serverCount: 1,
        connectedCount: 1,
        connectedTools: [GITHUB_ISSUES],
        toolSwitches: new Map()
      })
    ).toBe(
      `1 of 1 connected · 1 tool · ${formatToolTokenEstimate(calculateToolTokenEstimate(GITHUB_ISSUES))} per request`
    )
  })

  it("says no tool is offered while no server is connected", () => {
    expect(
      formatMcpServerListMeta({
        serverCount: 2,
        connectedCount: 0,
        connectedTools: [],
        toolSwitches: new Map()
      })
    ).toBe("0 of 2 connected · 0 tools · ~0 tok per request")
  })
})

describe("formatMcpToolOfferWarning", () => {
  it.each<[string, ToolModelSupport]>([
    ["unknown", { status: "unknown" }],
    ["trained", { status: "trained", modelKey: "qwen3-8b" }],
    ["untrained", { status: "untrained", modelKey: "gemma-3-4b" }]
  ])(
    "says nothing is offered while tool calls are off, whatever the model (%s)",
    (_, support) => {
      expect(formatMcpToolOfferWarning(false, support)).toBe(
        "Tool calls are off · servers stay connected, nothing from them is offered"
      )
    }
  )

  it("names a loaded model not trained for tool calls", () => {
    expect(
      formatMcpToolOfferWarning(true, {
        status: "untrained",
        modelKey: "gemma-3-4b"
      })
    ).toBe(
      "gemma-3-4b isn't trained for tool calls · nothing from here is offered"
    )
  })

  it.each<[string, ToolModelSupport]>([
    ["trained", { status: "trained", modelKey: "qwen3-8b" }],
    ["unknown", { status: "unknown" }]
  ])("warns of nothing while the tools are offered (%s)", (_, support) => {
    expect(formatMcpToolOfferWarning(true, support)).toBe("")
  })
})

describe("server limit", () => {
  it("allows another server until the most the settings allow are saved, and says so", () => {
    expect(canAddMcpServer(0)).toBe(true)
    expect(canAddMcpServer(15)).toBe(true)
    expect(canAddMcpServer(16)).toBe(false)
    expect(MCP_SERVER_LIMIT_NOTE).toBe(
      "Lys keeps up to 16 servers. Remove one to add another."
    )
  })
})

describe("skipped tools", () => {
  it.each([
    ["unsupported-name", "Its name is empty or too long to offer to a model."],
    [
      "duplicate-name",
      "Another tool of the server gets the same name once characters a tool name can't hold are replaced."
    ],
    [
      "unsupported-input-schema",
      "Its input schema isn't one Lys can offer to a model."
    ],
    ["input-schema-too-large", "Its input schema is too large to offer."]
  ] as const)(
    "says why a tool was skipped: %s",
    (reason: SkippedMcpToolReason, text) => {
      expect(formatSkippedMcpToolReason(reason)).toBe(text)
    }
  )

  it("names a tool without a name", () => {
    expect(formatSkippedMcpToolName("")).toBe("(no name)")
    expect(formatSkippedMcpToolName("search")).toBe("search")
  })

  it("keys each skipped tool by its reason and name, counting identical entries, and keeps a tool's key when others come before it", () => {
    const repeated = { name: "a", reason: "duplicate-name" } as const
    const unnamed = { name: "", reason: "unsupported-name" } as const
    const listings = listSkippedMcpTools([repeated, unnamed, repeated])

    expect(listings).toEqual([
      { key: "duplicate-name:0:a", tool: repeated },
      { key: "unsupported-name:0:", tool: unnamed },
      { key: "duplicate-name:1:a", tool: repeated }
    ])
    const added = { name: "b:0:a", reason: "duplicate-name" } as const
    expect(
      listSkippedMcpTools([added, repeated, unnamed, repeated]).map(
        ({ key }) => key
      )
    ).toEqual([
      "duplicate-name:0:b:0:a",
      "duplicate-name:0:a",
      "unsupported-name:0:",
      "duplicate-name:1:a"
    ])
    expect(listSkippedMcpTools([])).toEqual([])
  })

  it("says how many tools Lys reads of a server with more", () => {
    expect(MCP_TOOL_LIST_CUT_NOTE).toBe(
      "The server lists more tools than Lys reads. Lys reads the first 128."
    )
  })
})

describe("formatMcpSettingsOutcome", () => {
  it.each([
    ["applied", ""],
    [
      "invalid",
      "The mcp group in settings.json isn't valid. Lys keeps the servers it applied last."
    ],
    [
      "unreadable",
      "Lys couldn't read settings.json. Lys keeps the servers it applied last until it can read the file."
    ]
  ] as const)("explains the outcome %s", (settings, text) => {
    expect(
      formatMcpSettingsOutcome({ status: "loaded", settings, servers: [] })
    ).toBe(text)
  })

  it("says nothing while the list is not loaded", () => {
    expect(formatMcpSettingsOutcome({ status: "loading" })).toBe("")
  })
})

describe("listMcpPaneNotes", () => {
  it("says nothing while nothing needs saying", () => {
    const notes = listMcpPaneNotes(QUIET_FACTS)

    expect(notes).toEqual([])
    expect(Object.isFrozen(notes)).toBe(true)
  })

  it("only asks to start the backend while it is not running", () => {
    expect(
      listMcpPaneNotes({
        ...QUIET_FACTS,
        isBackendRunning: false,
        list: { status: "failed", error: "Unreachable." },
        actionFailure: {
          action: "sync",
          error: "Lys couldn't ask its backend to apply the MCP servers."
        }
      })
    ).toEqual([{ kind: "backend-stopped", text: MCP_BACKEND_STOPPED_NOTE }])
    expect(MCP_BACKEND_STOPPED_NOTE).toBe(
      "Start the backend in Settings → Runtime to connect to MCP servers."
    )
  })

  it("lists a failed read, the settings outcome, a failed action, and a failed save, in order", () => {
    expect(
      listMcpPaneNotes({
        ...QUIET_FACTS,
        list: { status: "loaded", settings: "invalid", servers: [] },
        actionFailure: {
          action: "reconnect",
          error: "Lys couldn't ask its backend to reconnect files."
        },
        saveState: FAILED_SAVE
      })
    ).toEqual([
      {
        kind: "settings-outcome",
        text: "The mcp group in settings.json isn't valid. Lys keeps the servers it applied last."
      },
      {
        kind: "action-failed",
        text: "Lys couldn't ask its backend to reconnect files."
      },
      {
        kind: "save-failed",
        text: "Lys couldn't write the MCP servers to its settings file."
      }
    ])
    expect(
      listMcpPaneNotes({
        ...QUIET_FACTS,
        list: { status: "failed", error: "Lys couldn't read the state." }
      })
    ).toEqual([{ kind: "read-failed", text: "Lys couldn't read the state." }])
  })

  it("leaves a failed save to the open editor, which shows it", () => {
    expect(
      listMcpPaneNotes({
        ...QUIET_FACTS,
        saveState: FAILED_SAVE,
        isEditing: true
      })
    ).toEqual([])
  })
})

describe("findMcpPaneRetry", () => {
  /** Failure of a sync the backend could not be asked. */
  const syncFailure = {
    action: "sync",
    error: "Lys couldn't ask its backend to apply the MCP servers."
  } as const

  it("retries applying the servers after a failed apply, even when the read failed too", () => {
    expect(
      findMcpPaneRetry({ ...QUIET_FACTS, actionFailure: syncFailure })
    ).toBe("sync")
    expect(
      findMcpPaneRetry({
        ...QUIET_FACTS,
        list: { status: "failed", error: "Unreachable." },
        actionFailure: syncFailure
      })
    ).toBe("sync")
  })

  it("retries the read after a failed read", () => {
    expect(
      findMcpPaneRetry({
        ...QUIET_FACTS,
        list: { status: "failed", error: "Unreachable." }
      })
    ).toBe("read")
  })

  it("offers no retry after a failed reconnect, while nothing failed, or while the backend is not running", () => {
    expect(
      findMcpPaneRetry({
        ...QUIET_FACTS,
        actionFailure: {
          action: "reconnect",
          error: "Lys couldn't ask its backend to reconnect files."
        }
      })
    ).toBeUndefined()
    expect(findMcpPaneRetry(QUIET_FACTS)).toBeUndefined()
    expect(
      findMcpPaneRetry({
        ...QUIET_FACTS,
        isBackendRunning: false,
        list: { status: "failed", error: "Unreachable." },
        actionFailure: syncFailure
      })
    ).toBeUndefined()
  })
})

describe("draft problems", () => {
  it("labels each field as the editor shows it", () => {
    expect(MCP_SERVER_DRAFT_FIELDS.map(formatMcpDraftFieldLabel)).toEqual([
      "Name",
      "Command",
      "Arguments",
      "Environment",
      "URL",
      "Token",
      "Headers"
    ])
  })

  it("lists the fields with a problem in the editor's order, each with its label", () => {
    const listings = listMcpDraftProblems({
      headers: "Header 2: Lys sets this header itself.",
      token: "Enter the token, or set sign-in to None.",
      name: "Enter a name.",
      url: "Enter a URL."
    })

    expect(listings).toEqual([
      { field: "name", label: "Name", problem: "Enter a name." },
      { field: "url", label: "URL", problem: "Enter a URL." },
      {
        field: "token",
        label: "Token",
        problem: "Enter the token, or set sign-in to None."
      },
      {
        field: "headers",
        label: "Headers",
        problem: "Header 2: Lys sets this header itself."
      }
    ])
    expect(Object.isFrozen(listings)).toBe(true)
    expect(listMcpDraftProblems({})).toEqual([])
  })

  it("asks to fix the fields with a problem, by their number", () => {
    expect(formatMcpDraftProblemSummaryHeading(3)).toBe("Fix 3 fields to save:")
  })
})

describe("sign-in", () => {
  it("labels each way to sign in in the editor's order", () => {
    expect(MCP_SIGN_INS.map(formatMcpSignInLabel)).toEqual(["None", "Token"])
  })

  it.each([
    [
      "none",
      "Anyone who can reach the URL can use it. Fine for servers on your own network."
    ],
    [
      "token",
      "Sent as Authorization: Bearer … with each request, and saved in plain text."
    ]
  ] as const)("says what signing in with %s means", (signIn, note) => {
    expect(formatMcpSignInNote(signIn)).toBe(note)
  })
})

describe("editor texts", () => {
  it.each([
    ["github", "its tools arrive as mcp__github__…"],
    ["  github ", "its tools arrive as mcp__github__…"],
    ["", "its tools arrive as mcp__name__…"],
    ["   ", "its tools arrive as mcp__name__…"]
  ])("previews the tool names of the name %j", (name, preview) => {
    expect(formatMcpToolNamePreview(name)).toBe(preview)
  })

  it("tags a new server, or the saved server being edited by its name", () => {
    expect(formatMcpEditorKind(undefined)).toBe("new server")
    expect(formatMcpEditorKind("github")).toBe("editing · github")
  })

  it("says what ⌘ Enter does for a new server and for a saved one", () => {
    expect(formatMcpEditorHint(true)).toBe("⌘ enter adds it")
    expect(formatMcpEditorHint(false)).toBe(
      "⌘ enter saves · it reconnects with the new settings"
    )
  })

  it("states the name rule with the longest name before entry", () => {
    expect(MCP_SERVER_NAME_RULE).toBe("a-z, 0-9, single hyphens · up to 20")
  })

  it.each([
    [
      "environment",
      {
        itemName: "variable",
        hint: "NAME: letters, digits, _ · values saved in plain text",
        namePlaceholder: "GITHUB_TOKEN"
      }
    ],
    [
      "headers",
      {
        itemName: "header",
        hint: "optional · values saved in plain text",
        namePlaceholder: "X-Workspace"
      }
    ]
  ] as const)("presents the %s rows", (list, presentation) => {
    expect(getMcpEntryListPresentation(list)).toEqual(presentation)
  })
})

describe("formatMcpServerJsonMessage", () => {
  it.each([
    ["not-json", "not valid json yet"],
    ["not-object", "expected an object"],
    ["no-servers", "no servers in it"],
    ["no-command-or-url", "found no command or url"],
    ["unreadable-values", "its args, env, or headers aren't text"],
    ["sse", "lys doesn't speak sse · use the server's streamable http url"]
  ] as const)("says why a paste filled nothing: %s", (problem, text) => {
    expect(formatMcpServerJsonMessage({ status: "invalid", problem })).toEqual({
      text,
      isFilled: false
    })
  })

  it("names the one server a paste filled the fields from", () => {
    expect(
      formatMcpServerJsonMessage(buildFilledJsonParse("github", 1))
    ).toEqual({ text: "filled from json · github", isFilled: true })
  })

  it("says one server filled the fields when neither the paste nor the person named it", () => {
    expect(formatMcpServerJsonMessage(buildFilledJsonParse("", 1))).toEqual({
      text: "filled from json · one server",
      isFilled: true
    })
  })

  it("says only the first of several servers filled the fields, and how to add the rest", () => {
    expect(
      formatMcpServerJsonMessage(buildFilledJsonParse("github", 3))
    ).toEqual({
      text: "filled from json · first of 3 servers · add the rest the same way",
      isFilled: true
    })
  })
})

describe("pane notes", () => {
  it("describes the empty list, the paste field, and the tool chips", () => {
    expect(MCP_EMPTY_LIST_NOTE).toBe(
      "No servers yet. Each one gives the agents more tools: your issue tracker, a database, a repository. Add one by the command that starts it, or by its URL."
    )
    expect(MCP_SERVER_JSON_HINT).toBe(
      "claude_desktop_config.json, .cursor/mcp.json or a single server object"
    )
    expect(MCP_TOOL_CHIPS_NOTE).toBe(
      "Click a tool to leave it out. Every tool that is on is described to the model with each request."
    )
  })
})
