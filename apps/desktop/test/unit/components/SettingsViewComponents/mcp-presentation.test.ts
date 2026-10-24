import type { McpServerFailure, SkippedMcpToolReason } from "@lys/protocol"
import { mcpServerSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  canAddMcpServer,
  findMcpServerStatus,
  formatMcpServerCount,
  formatMcpServerRowState,
  formatMcpServerState,
  formatMcpServerTarget,
  formatMcpServerTransportLabel,
  formatMcpSettingsOutcome,
  formatSkippedMcpToolName,
  formatSkippedMcpToolReason,
  findMcpPaneRetry,
  formatMcpDraftFieldLabel,
  formatMcpDraftProblemSummaryHeading,
  listMcpDraftProblems,
  listMcpPaneNotes,
  listSkippedMcpTools,
  MCP_BACKEND_STOPPED_NOTE,
  MCP_SERVER_TRANSPORTS,
  MCP_TOOL_LIST_CUT_NOTE,
  type McpPaneFacts
} from "@/components/SettingsViewComponents/mcp-presentation"
import { MCP_SERVER_DRAFT_FIELDS } from "@/lib/models/mcp-server-draft"
import type { McpServerListState } from "@/lib/store/mcp-servers"
import {
  buildConnectedMcpState,
  buildFailedMcpState,
  buildMcpServerStatus,
  CONNECTING_MCP_STATE
} from "../../support/mcpFixtures"
import { STORED_MCP_SETTINGS } from "../../support/settingsFixtures"

/** Loaded list with the stored command server connected. */
const LOADED_LIST: McpServerListState = Object.freeze({
  status: "loaded",
  settings: "applied",
  servers: [buildMcpServerStatus("files", "stdio", buildConnectedMcpState(2))]
})

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
  it("offers a command first, then a URL", () => {
    expect(MCP_SERVER_TRANSPORTS).toEqual(["stdio", "http"])
    expect(MCP_SERVER_TRANSPORTS.map(formatMcpServerTransportLabel)).toEqual([
      "Command",
      "URL"
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
    const server = mcpServerSettingsSchema.parse({
      name: "bare",
      transport: "stdio",
      command: "/usr/local/bin/bare"
    })

    expect(formatMcpServerTarget(server)).toBe("/usr/local/bin/bare")
  })

  it("shows a URL, never its headers", () => {
    expect(formatMcpServerTarget(STORED_MCP_SETTINGS.servers[1])).toBe(
      "https://mcp.example.test/notes"
    )
  })
})

describe("formatMcpServerState", () => {
  it("says a server is connecting", () => {
    expect(formatMcpServerState(CONNECTING_MCP_STATE)).toEqual({
      text: "Connecting…",
      tone: "pending"
    })
  })

  it.each([
    [buildConnectedMcpState(1), "Connected · 1 tool"],
    [buildConnectedMcpState(0), "Connected · 0 tools"],
    [
      buildConnectedMcpState(4, [
        { name: "a", reason: "unsupported-name" },
        { name: "b", reason: "duplicate-name" }
      ]),
      "Connected · 4 tools · 2 skipped"
    ]
  ])("counts the tools of a connected server: %o", (state, text) => {
    expect(formatMcpServerState(state)).toEqual({ text, tone: "success" })
  })

  it.each([
    [
      "start-failed",
      "Failed: Lys couldn't start the command. Check that it exists; use its full path."
    ],
    ["closed", "Failed: The server closed the connection."],
    ["timed-out", "Failed: The server didn't answer within 2 minutes."],
    [
      "unauthorized",
      "Failed: The server refused the request. Check the headers, such as Authorization."
    ],
    ["unreachable", "Failed: Lys couldn't reach the server."],
    ["http-error", "Failed: The server answered with an HTTP error."],
    ["protocol-error", "Failed: The server's answer isn't valid MCP."]
  ] as const)(
    "says why a server failed: %s",
    (reason: McpServerFailure, text) => {
      expect(formatMcpServerState(buildFailedMcpState(reason))).toEqual({
        text,
        tone: "danger"
      })
    }
  )
})

describe("formatMcpServerRowState", () => {
  it("says nothing while the backend is not running", () => {
    expect(
      formatMcpServerRowState({
        isBackendRunning: false,
        list: LOADED_LIST,
        serverName: "files"
      })
    ).toEqual({ text: "", tone: "neutral" })
  })

  it.each([
    [{ status: "idle" }],
    [{ status: "loading" }],
    [{ status: "failed", error: "Unreachable." }]
  ] as const)("says nothing while the list is %o", (list) => {
    expect(
      formatMcpServerRowState({
        isBackendRunning: true,
        list,
        serverName: "files"
      })
    ).toEqual({ text: "", tone: "neutral" })
  })

  it("shows the state of a server the backend applied", () => {
    expect(
      formatMcpServerRowState({
        isBackendRunning: true,
        list: LOADED_LIST,
        serverName: "files"
      })
    ).toEqual({ text: "Connected · 2 tools", tone: "success" })
  })

  it("says a saved server the backend did not apply is not applied", () => {
    expect(
      formatMcpServerRowState({
        isBackendRunning: true,
        list: LOADED_LIST,
        serverName: "notes"
      })
    ).toEqual({
      text: "Not applied. Reconnect applies the saved servers.",
      tone: "neutral"
    })
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

describe("server count", () => {
  it("counts the saved servers against the most the settings allow", () => {
    expect(formatMcpServerCount(2)).toBe("2 of 16")
    expect(canAddMcpServer(15)).toBe(true)
    expect(canAddMcpServer(16)).toBe(false)
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
      "Headers"
    ])
  })

  it("lists the fields with a problem in the editor's order, each with its label", () => {
    const listings = listMcpDraftProblems({
      headers: "Line 2: write each header as Name: value.",
      name: "Enter a name.",
      url: "Enter a URL."
    })

    expect(listings).toEqual([
      { field: "name", label: "Name", problem: "Enter a name." },
      { field: "url", label: "URL", problem: "Enter a URL." },
      {
        field: "headers",
        label: "Headers",
        problem: "Line 2: write each header as Name: value."
      }
    ])
    expect(Object.isFrozen(listings)).toBe(true)
    expect(listMcpDraftProblems({})).toEqual([])
  })

  it("asks to fix the fields with a problem, by their number", () => {
    expect(formatMcpDraftProblemSummaryHeading(3)).toBe("Fix 3 fields to save:")
  })
})
