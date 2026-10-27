import {
  MAXIMUM_MCP_SERVER_TOOL_COUNT,
  type ListedBackendToolUnavailableReason,
  type McpServerFailure,
  type McpServerList,
  type McpServerState,
  type McpServerStatus,
  type SkippedMcpTool,
  type SkippedMcpToolReason
} from "@lys/protocol"
import {
  buildMcpToolNamePrefix,
  MAXIMUM_MCP_SERVER_COUNT,
  MAXIMUM_MCP_SERVER_NAME_LENGTH,
  type McpServerName,
  type McpServerSettings,
  type McpServerTransport,
  type McpToolDefinition
} from "@lys/share"

import { formatMcpCommandArguments } from "@/lib/models/mcp-command-arguments"
import {
  buildMcpServerDraft,
  MCP_SERVER_DRAFT_FIELDS,
  type McpDraftEntryList,
  type McpServerDraftField,
  type McpServerDraftProblems,
  type McpSignIn
} from "@/lib/models/mcp-server-draft"
import type {
  McpServerJsonParse,
  McpServerJsonProblem
} from "@/lib/models/mcp-server-json"
import type { ToolModelSupport } from "@/lib/models/tool-model-support"
import type {
  McpServerActionFailure,
  McpServerListState
} from "@/lib/store/mcp-servers"
import type { McpSettingsSaveState } from "@/lib/store/mcp-settings"
import { getToolApproval, type ToolApproval } from "@/lib/store/tool-settings"
import type { ToolListState } from "@/lib/store/tools"

import {
  calculateOfferedToolTotals,
  formatToolTokenEstimate
} from "./tool-presentation"

/** How a transport is shown: its tag, its name, and what it means. */
export type McpTransportPresentation = {
  /** Short lowercase tag, such as `stdio`. */
  readonly tag: string
  /** Name of the kind of server, such as `Local program`. */
  readonly name: string
  /** What Lys does with such a server, in one or two sentences. */
  readonly blurb: string
  /** Example of what such a server runs or reaches. */
  readonly example: string
}

/**
 * Where a saved server stands: `connected`, `connecting`, `failed`, or
 * `idle` while it is not applied or its state is not known.
 */
export type McpServerCondition = "connected" | "connecting" | "failed" | "idle"

/** A server's state as its row and its details show it. */
export type McpServerStatusPresentation = {
  /** Where the server stands, which the row's dot shows. */
  readonly condition: McpServerCondition
  /** Short lowercase tag beside the name, or empty while none is shown. */
  readonly chip: string
  /** State in a few words, such as `Connected`. */
  readonly heading: string
  /** What the state means or why, or empty while there is nothing to add. */
  readonly detail: string
}

/** Facts a saved server's state is drawn from. */
export type McpServerRowFacts = {
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Saved settings of the server. */
  readonly server: McpServerSettings
}

/** Facts the MCP pane's status line is drawn from. */
export type McpPaneFacts = {
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Failure of the latest sync or reconnect, or null. */
  readonly actionFailure: McpServerActionFailure | null
  /** Latest save of the servers. */
  readonly saveState: McpSettingsSaveState
  /** Whether the editor is open, which shows a failed save itself. */
  readonly isEditing: boolean
}

/** Facts the note about a server without listed tools is drawn from. */
export type McpServerToolsFacts = {
  /** Where the server stands. */
  readonly condition: McpServerCondition
  /** Lifecycle of the tool list. */
  readonly toolList: ToolListState
  /** Number of the server's tools the backend skipped. */
  readonly skippedToolCount: number
}

/** Facts the meta line beside the servers heading is drawn from. */
export type McpServerListMetaFacts = {
  /** Number of saved servers. */
  readonly serverCount: number
  /** Number of them connected, or undefined while their states are not known. */
  readonly connectedCount: number | undefined
  /** Tools of the connected servers, or undefined while the tools are not read. */
  readonly connectedTools: readonly McpToolDefinition[] | undefined
  /** Saved switches by tool name. */
  readonly toolSwitches: ReadonlyMap<string, boolean>
}

/**
 * Approval of a server's tools: one approval when every listed tool has it,
 * `mixed` when they differ, `none` while no tool is listed.
 */
export type McpServerApproval = ToolApproval | "mixed" | "none"

/** One line of a server's configuration. */
export type McpConfigurationLine = {
  /** What the line is about, such as `command`; unique within a server. */
  readonly label: string
  /** The setting, never a secret value. */
  readonly value: string
  /** Whether the setting is empty, which the value says as `none`. */
  readonly isNone: boolean
}

/** Words a transport's server connects, reconnects, and runs by. */
type McpConnectionWords = {
  /** Label of the button that connects an idle server, such as `Start`. */
  readonly connectLabel: string
  /** Label of the button that connects a live server again, such as `Restart`. */
  readonly reconnectLabel: string
  /** Heading of a connected server's state, such as `Running`. */
  readonly connectedHeading: string
}

/** Outcome of pasting a config, as the editor says it. */
export type McpServerJsonMessage = {
  /** What happened, in lowercase. */
  readonly text: string
  /** Whether the config filled the fields. */
  readonly isFilled: boolean
}

/** Transports in the order the editor offers them. */
export const MCP_SERVER_TRANSPORTS: readonly McpServerTransport[] =
  Object.freeze(["stdio", "http"])

/** How each transport is shown; a new transport must add one. */
const MCP_TRANSPORT_PRESENTATIONS = Object.freeze({
  stdio: Object.freeze({
    tag: "stdio",
    name: "Local program",
    blurb:
      "Lys starts it on this machine and talks to it over stdin and stdout. It stops when Lys does.",
    example: "npx -y @modelcontextprotocol/server-github"
  }),
  http: Object.freeze({
    tag: "http",
    name: "Remote server",
    blurb:
      "Lys reaches it at a URL. It runs wherever it is hosted and may need a token.",
    example: "https://mcp.example.com/mcp"
  })
} satisfies Readonly<Record<McpServerTransport, McpTransportPresentation>>)

/** Words for a server's connection, by transport; a new transport must add one. */
const MCP_CONNECTION_WORDS = Object.freeze({
  stdio: Object.freeze({
    connectLabel: "Start",
    reconnectLabel: "Restart",
    connectedHeading: "Running"
  }),
  http: Object.freeze({
    connectLabel: "Connect",
    reconnectLabel: "Reconnect",
    connectedHeading: "Connected"
  })
} satisfies Readonly<Record<McpServerTransport, McpConnectionWords>>)

/** Why a server is not connected; a new reason must add one. */
const MCP_SERVER_FAILURE_TEXTS = Object.freeze({
  "start-failed":
    "Lys couldn't start the command. Check that it exists; use its full path.",
  closed:
    "The connection ended: the server stopped or closed it, or sent an answer too large to read.",
  "timed-out": "The server didn't answer within 2 minutes.",
  unauthorized:
    "The server refused the request. Check the token and the headers.",
  unreachable: "Lys couldn't reach the server.",
  "http-error":
    "The server answered with an HTTP error or a redirect, which Lys doesn't follow.",
  "protocol-error":
    "The server refused to connect or to list its tools, or its answer was too large or not valid MCP."
} satisfies Readonly<Record<McpServerFailure, string>>)

/** Why a tool of a server is not listed; a new reason must add one. */
const SKIPPED_MCP_TOOL_REASON_TEXTS = Object.freeze({
  "unsupported-name":
    "Its name is empty, too long, or holds characters you can't see.",
  "duplicate-name":
    "Another tool of the server gets the same name once characters a tool name can't hold are replaced.",
  "unsupported-input-schema":
    "Its input schema isn't one Lys can offer to a model.",
  "input-schema-too-large": "Its input schema is too large to offer."
} satisfies Readonly<Record<SkippedMcpToolReason, string>>)

/**
 * What the backend's last read of the `mcp` group says, when it did not
 * apply it; a new outcome must add one.
 */
const MCP_SETTINGS_OUTCOME_TEXTS = Object.freeze({
  applied: "",
  invalid:
    "The mcp group in settings.json isn't valid. Lys keeps the servers it applied last.",
  unreadable:
    "Lys couldn't read settings.json. Lys keeps the servers it applied last until it can read the file."
} satisfies Readonly<Record<McpServerList["settings"], string>>)

/** Note about a server's approval, by approval; a new approval must add one. */
const MCP_SERVER_APPROVAL_NOTES = Object.freeze({
  ask: "You see each call and its arguments first. Nothing runs until you say yes.",
  run: "Its tools run the moment the model asks. Only for servers you trust.",
  mixed:
    "Some of its tools ask first and some run at once. Choose one for all of them.",
  none: "You can choose once it lists its tools. Each then follows the choice saved for it, and a tool without one asks first."
} satisfies Readonly<Record<McpServerApproval, string>>)

/** What each problem of a pasted config says; a new problem must add one. */
const MCP_SERVER_JSON_PROBLEM_TEXTS = Object.freeze({
  "not-json": "not valid json yet",
  "not-object": "expected an object",
  "no-servers": "no servers in it",
  "no-command-or-url": "found no command or url",
  "unreadable-values": "its args, env, or headers aren't text",
  sse: "lys doesn't speak sse · use the server's streamable http url"
} satisfies Readonly<Record<McpServerJsonProblem, string>>)

/** Label of each way to sign in; a new way must add one. */
const MCP_SIGN_IN_LABELS = Object.freeze({
  none: "None",
  token: "Token"
} satisfies Readonly<Record<McpSignIn, string>>)

/** Note under each way to sign in; a new way must add one. */
const MCP_SIGN_IN_NOTES = Object.freeze({
  none: "Anyone who can reach the URL can use it. Fine for servers on your own network.",
  token:
    "Sent as Authorization: Bearer … with each request, and saved in plain text."
} satisfies Readonly<Record<McpSignIn, string>>)

/** Label of each editor field; a new field must add one. */
const MCP_DRAFT_FIELD_LABELS = Object.freeze({
  name: "Name",
  command: "Command",
  arguments: "Arguments",
  environment: "Environment",
  url: "URL",
  token: "Token",
  headers: "Headers"
} satisfies Readonly<Record<McpServerDraftField, string>>)

/**
 * Tool estimates that leave out no tool for being unavailable: only Lys's
 * backend tools that need a key can be unavailable, never a server's.
 */
const NO_UNAVAILABLE_TOOLS: ReadonlyMap<
  string,
  ListedBackendToolUnavailableReason
> = new Map<string, ListedBackendToolUnavailableReason>()

/** Note shown while the backend is not running. */
export const MCP_BACKEND_STOPPED_NOTE =
  "Start the backend in Settings → Runtime to connect to MCP servers."

/** Note shown with the skipped tools of a server that has more than Lys reads. */
export const MCP_TOOL_LIST_CUT_NOTE = `The server lists more tools than Lys reads. Lys reads the first ${MAXIMUM_MCP_SERVER_TOOL_COUNT}.`

/** Note shown under a server's listed tools. */
export const MCP_TOOL_CHIPS_NOTE =
  "Click a tool to leave it out. Every tool that is on is described to the model with each request."

/** Note shown once the most servers the settings allow are saved. */
export const MCP_SERVER_LIMIT_NOTE = `Lys keeps up to ${MAXIMUM_MCP_SERVER_COUNT} servers. Remove one to add another.`

/** Text of the pane without servers. */
export const MCP_EMPTY_LIST_NOTE =
  "No servers yet. Each one gives the agents more tools: your issue tracker, a database, a repository. Add one by the command that starts it, or by its URL."

/** Rule of a server name, shown before entry. */
export const MCP_SERVER_NAME_RULE = `a-z, 0-9, single hyphens · up to ${MAXIMUM_MCP_SERVER_NAME_LENGTH}`

/** What the paste field accepts, shown until something is pasted. */
export const MCP_SERVER_JSON_HINT =
  "claude_desktop_config.json, .cursor/mcp.json or a single server object"

/**
 * Gets how a transport is shown.
 *
 * @param transport - How Lys talks to the server.
 * @returns Its tag, name, blurb, and example.
 */
export function getMcpTransportPresentation(
  transport: McpServerTransport
): McpTransportPresentation {
  return MCP_TRANSPORT_PRESENTATIONS[transport]
}

/**
 * Formats a server's URL with its query hidden, because a query can hold a
 * key.
 *
 * @param url - Saved URL, which has no user name, password, or fragment.
 * @returns The URL up to its first `?`, followed by `?…` when it has one;
 * the URL as saved otherwise.
 */
function formatMcpServerUrl(url: string): string {
  const queryStart = url.indexOf("?")
  return queryStart === -1 ? url : `${url.slice(0, queryStart)}?…`
}

/**
 * Formats what a server's row says it runs or reaches.
 *
 * @param server - Saved server settings.
 * @returns The command followed by its arguments, quoted where needed, or
 * the URL with its query hidden. Environment values, headers, and a URL's
 * query, which can be secrets, are never shown.
 */
export function formatMcpServerTarget(server: McpServerSettings): string {
  if (server.transport === "http") return formatMcpServerUrl(server.url)
  return [server.command, formatMcpCommandArguments(server.arguments)]
    .filter((part) => part !== "")
    .join(" ")
}

/**
 * Finds the state the backend reports for a saved server.
 *
 * @param list - Lifecycle of the list of applied servers.
 * @param serverName - Name of the saved server.
 * @returns The applied server, or undefined when the list is not loaded or
 * does not hold the name.
 */
export function findMcpServerStatus(
  list: McpServerListState,
  serverName: McpServerName
): McpServerStatus | undefined {
  if (list.status !== "loaded") return undefined
  return list.servers.find((server) => server.name === serverName)
}

/**
 * Formats a count of tools.
 *
 * @param count - Number of tools.
 * @returns `1 tool` or `N tools`.
 */
function formatToolCount(count: number): string {
  return count === 1 ? "1 tool" : `${count} tools`
}

/**
 * Formats the state of a server whose state the backend does not report.
 *
 * @param facts - Backend status, the list, and the server.
 * @returns That the backend is not running, that the states are being read
 * or could not be read, or that the server is not applied.
 */
function formatIdleStatus(
  facts: McpServerRowFacts
): McpServerStatusPresentation {
  if (!facts.isBackendRunning) {
    return {
      condition: "idle",
      chip: "",
      heading: "Not connected",
      detail: "Lys connects once the backend runs."
    }
  }
  if (facts.list.status === "loaded") {
    return {
      condition: "idle",
      chip: "not applied",
      heading: "Not applied",
      detail: `${formatMcpReconnectLabel(facts.server.transport, "idle")} applies the saved servers.`
    }
  }
  return {
    condition: "idle",
    chip: "",
    heading: "State unknown",
    detail:
      facts.list.status === "failed"
        ? "Lys couldn't read the server states."
        : "Reading the server states…"
  }
}

/**
 * Formats the state of a server that is starting or connecting.
 *
 * @param server - Saved settings of the server.
 * @returns `starting` for a command, `connecting` for a URL, with what Lys
 * waits for.
 */
function formatConnectingStatus(
  server: McpServerSettings
): McpServerStatusPresentation {
  switch (server.transport) {
    case "stdio":
      return {
        condition: "connecting",
        chip: "starting",
        heading: "Starting",
        detail: "started · waiting for initialize"
      }
    case "http":
      return {
        condition: "connecting",
        chip: "connecting",
        heading: "Connecting",
        detail: `waiting for initialize from ${new URL(server.url).host}`
      }
  }
}

/**
 * Formats the state of a connected server.
 *
 * @param server - Saved settings of the server.
 * @param state - Connected state.
 * @returns `Running` for a command, `Connected` for a URL, with how many
 * tools it lists and how many the backend skipped.
 */
function formatConnectedStatus(
  server: McpServerSettings,
  state: Extract<McpServerState, { readonly status: "connected" }>
): McpServerStatusPresentation {
  const listed = `${formatToolCount(state.toolCount)} listed`
  const skippedCount = state.skippedTools.length
  return {
    condition: "connected",
    chip: "",
    heading: MCP_CONNECTION_WORDS[server.transport].connectedHeading,
    detail: skippedCount === 0 ? listed : `${listed} · ${skippedCount} skipped`
  }
}

/**
 * Formats a saved server's state.
 *
 * @param facts - Backend status, the list, and the server.
 * @returns Its condition, chip, heading, and detail: the state the backend
 * reports while it runs and lists the server; otherwise an idle state that
 * says why none is known.
 */
export function formatMcpServerStatus(
  facts: McpServerRowFacts
): McpServerStatusPresentation {
  const status = facts.isBackendRunning
    ? findMcpServerStatus(facts.list, facts.server.name)
    : undefined
  if (status === undefined) return formatIdleStatus(facts)
  const { state } = status
  switch (state.status) {
    case "connecting":
      return formatConnectingStatus(facts.server)
    case "connected":
      return formatConnectedStatus(facts.server, state)
    case "failed":
      return {
        condition: "failed",
        chip: "failed",
        heading: "Failed",
        detail: MCP_SERVER_FAILURE_TEXTS[state.reason]
      }
  }
}

/**
 * Formats the label of the button that connects a server again.
 *
 * @param transport - How Lys talks to the server.
 * @param condition - Where the server stands.
 * @returns `Retry` after a failure; `Restart` or `Reconnect` while it is
 * connected or connecting; `Start` or `Connect` while it is idle.
 */
export function formatMcpReconnectLabel(
  transport: McpServerTransport,
  condition: McpServerCondition
): string {
  const words = MCP_CONNECTION_WORDS[transport]
  switch (condition) {
    case "failed":
      return "Retry"
    case "idle":
      return words.connectLabel
    case "connected":
    case "connecting":
      return words.reconnectLabel
  }
}

/**
 * Lists the tools of one connected server.
 *
 * @param toolList - Lifecycle of the tool list.
 * @param serverName - Name of the server.
 * @param condition - Where the server stands.
 * @returns The server's tools in the backend's order while it is connected
 * and the tool list is read; none otherwise, so the tools of a server that
 * left are not shown.
 */
export function listMcpServerTools(
  toolList: ToolListState,
  serverName: McpServerName,
  condition: McpServerCondition
): readonly McpToolDefinition[] {
  if (condition !== "connected" || toolList.status !== "loaded") return []
  return toolList.tools.filter(
    (tool): tool is McpToolDefinition =>
      tool.runner === "mcp" && tool.server === serverName
  )
}

/**
 * Formats the tool count of a server's row.
 *
 * @param onCount - Number of its listed tools that are on.
 * @param toolCount - Number of its listed tools.
 * @returns `N tools` while every tool is on, `N of M tools` otherwise, or
 * empty while it lists none.
 */
export function formatMcpServerToolCount(
  onCount: number,
  toolCount: number
): string {
  if (toolCount === 0) return ""
  if (onCount === toolCount) return formatToolCount(toolCount)
  return `${onCount} of ${toolCount} tools`
}

/**
 * Formats the meta line of a server's tools.
 *
 * @param tools - The server's listed tools.
 * @param toolSwitches - Saved switches by tool name.
 * @returns `n of m on · ~T tok`, the estimate covering the tools that are on.
 */
export function formatMcpServerToolMeta(
  tools: readonly McpToolDefinition[],
  toolSwitches: ReadonlyMap<string, boolean>
): string {
  const totals = calculateOfferedToolTotals(
    tools,
    toolSwitches,
    NO_UNAVAILABLE_TOOLS
  )
  const estimate = formatToolTokenEstimate(totals.offeredTokenCount)
  return `${totals.offeredToolCount} of ${tools.length} on · ${estimate}`
}

/**
 * Formats what a server's tools section says while it shows no tool.
 *
 * @param facts - The server's condition, the tool list, and its skipped
 * tools.
 * @returns Why no tool is shown: it failed before listing them, its tools
 * are being listed, the tool list could not be read, it lists none, or it is
 * not connected.
 */
export function formatMcpServerToolsNote(facts: McpServerToolsFacts): string {
  switch (facts.condition) {
    case "failed":
      return "It stopped before listing any tools. Fix the cause above, then retry."
    case "connecting":
      return "Listing tools…"
    case "idle":
      return "No tools seen yet. They show up once it connects."
    case "connected":
      break
  }
  if (facts.toolList.status === "failed") return facts.toolList.error
  if (facts.toolList.status !== "loaded") return "Listing tools…"
  return facts.skippedToolCount === 0
    ? "It lists no tools."
    : "It lists no tool Lys can offer."
}

/**
 * Finds the approval of a server's tools.
 *
 * @param tools - The server's listed tools.
 * @param justRunToolNames - Names of the tools on Just run.
 * @returns The approval every tool has, `mixed` when they differ, or `none`
 * while the server lists no tool.
 */
export function findMcpServerApproval(
  tools: readonly McpToolDefinition[],
  justRunToolNames: ReadonlySet<string>
): McpServerApproval {
  const approvals = new Set(
    tools.map((tool) => getToolApproval(justRunToolNames, tool.name))
  )
  const [approval] = approvals
  if (approval === undefined) return "none"
  return approvals.size === 1 ? approval : "mixed"
}

/**
 * Formats the note about a server's approval.
 *
 * @param approval - Approval of the server's tools.
 * @returns What the approval means for its calls.
 */
export function formatMcpServerApprovalNote(
  approval: McpServerApproval
): string {
  return MCP_SERVER_APPROVAL_NOTES[approval]
}

/**
 * Formats a list of names, or that there is none.
 *
 * @param label - What the line is about.
 * @param names - Names in order.
 * @returns The line, its value the names joined by commas, or `none`.
 */
function buildNameLine(
  label: string,
  names: readonly string[]
): McpConfigurationLine {
  const isNone = names.length === 0
  return { label, value: isNone ? "none" : names.join(", "), isNone }
}

/**
 * Lists a server's configuration as its details show it.
 *
 * @param server - Saved server settings.
 * @returns A frozen list of lines, each label once: a command server's
 * transport, command, arguments, and the names of its variables; a URL
 * server's transport, URL with its query hidden, sign-in, and the names of
 * its other headers. Values that can be secrets are never shown.
 */
export function listMcpServerConfiguration(
  server: McpServerSettings
): readonly McpConfigurationLine[] {
  const draft = buildMcpServerDraft(server)
  if (server.transport === "http") {
    const isSignedIn = draft.signIn === "token"
    return Object.freeze([
      { label: "transport", value: "streamable http", isNone: false },
      { label: "url", value: formatMcpServerUrl(server.url), isNone: false },
      {
        label: "sign-in",
        value: isSignedIn ? "bearer token" : "none",
        isNone: !isSignedIn
      },
      buildNameLine(
        "headers",
        draft.headers.map((header) => header.name)
      )
    ])
  }
  const argumentText = draft.argumentText
  return Object.freeze([
    {
      label: "transport",
      value: "stdio · child process of Lys",
      isNone: false
    },
    { label: "command", value: server.command, isNone: false },
    {
      label: "arguments",
      value: argumentText === "" ? "none" : argumentText,
      isNone: argumentText === ""
    },
    buildNameLine(
      "environment",
      server.environment.map((variable) => variable.name)
    )
  ])
}

/**
 * Formats the question asked before removing a server.
 *
 * @param server - Saved server settings.
 * @returns `remove <name> and its secrets?` for a server with environment
 * variables or headers, which may hold secrets, and `remove <name>?`
 * otherwise.
 */
export function formatMcpServerRemovalQuestion(
  server: McpServerSettings
): string {
  const secretCount =
    server.transport === "http"
      ? server.headers.length
      : server.environment.length
  return secretCount === 0
    ? `remove ${server.name}?`
    : `remove ${server.name} and its secrets?`
}

/**
 * Calculates how many saved servers the backend reports connected.
 *
 * @param servers - Saved servers.
 * @param list - Lifecycle of the list of applied servers.
 * @param isBackendRunning - Whether the backend is running.
 * @returns The number, or undefined while the backend is not running or the
 * list is not loaded.
 */
export function calculateConnectedMcpServerCount(
  servers: readonly McpServerSettings[],
  list: McpServerListState,
  isBackendRunning: boolean
): number | undefined {
  if (!isBackendRunning || list.status !== "loaded") return undefined
  return servers.filter(
    (server) =>
      findMcpServerStatus(list, server.name)?.state.status === "connected"
  ).length
}

/**
 * Formats the meta line beside the servers heading.
 *
 * @param facts - Number of saved servers, how many are connected, the
 * connected servers' tools, and the switches.
 * @returns `none yet`; `N saved` while their states are not known;
 * otherwise `C of N connected`, followed by the tools on and their estimate
 * per request once the tools are read.
 */
export function formatMcpServerListMeta(facts: McpServerListMetaFacts): string {
  if (facts.serverCount === 0) return "none yet"
  if (facts.connectedCount === undefined) return `${facts.serverCount} saved`
  const connected = `${facts.connectedCount} of ${facts.serverCount} connected`
  if (facts.connectedTools === undefined) return connected
  const totals = calculateOfferedToolTotals(
    facts.connectedTools,
    facts.toolSwitches,
    NO_UNAVAILABLE_TOOLS
  )
  const estimate = formatToolTokenEstimate(totals.offeredTokenCount)
  return `${connected} · ${formatToolCount(totals.offeredToolCount)} · ${estimate} per request`
}

/**
 * Formats the warning that the servers' tools are not offered.
 *
 * @param areToolCallsOn - Whether tool calls are on for this session.
 * @param support - Whether the loaded model can be offered tools.
 * @returns Why nothing from the servers is offered, or empty while their
 * tools are offered.
 */
export function formatMcpToolOfferWarning(
  areToolCallsOn: boolean,
  support: ToolModelSupport
): string {
  if (!areToolCallsOn) {
    return "Tool calls are off · servers stay connected, nothing from them is offered"
  }
  if (support.status !== "untrained") return ""
  return `${support.modelKey} isn't trained for tool calls · nothing from here is offered`
}

/**
 * Answers whether another server can be saved.
 *
 * @param count - Number of saved servers.
 * @returns True while fewer servers are saved than the settings allow.
 */
export function canAddMcpServer(count: number): boolean {
  return count < MAXIMUM_MCP_SERVER_COUNT
}

/**
 * Formats why the backend skipped one tool.
 *
 * @param reason - Why the tool is not listed.
 * @returns One sentence.
 */
export function formatSkippedMcpToolReason(
  reason: SkippedMcpToolReason
): string {
  return SKIPPED_MCP_TOOL_REASON_TEXTS[reason]
}

/**
 * Formats the name of a skipped tool.
 *
 * @param name - The server's name for the tool, which may be empty.
 * @returns The name, or `(no name)` when it is empty.
 */
export function formatSkippedMcpToolName(name: string): string {
  return name === "" ? "(no name)" : name
}

/** One skipped tool as a server's details list it. */
export type SkippedMcpToolListing = {
  /**
   * List key: the tool's reason, how many identical entries come before it,
   * and its name.
   */
  readonly key: string
  /** The skipped tool. */
  readonly tool: SkippedMcpTool
}

/**
 * Lists a server's skipped tools with a key for each.
 *
 * @remarks A skipped tool has no identity beyond its reason and its name,
 * which may be empty or repeat, so the key counts the identical entries
 * before it. The key then stays with the same tool when the backend reads
 * the server again and other tools come or go. The reason and the count
 * hold no `:`, so different entries never share a key.
 * @param skippedTools - Skipped tools in the server's order.
 * @returns One listing per skipped tool, in the same order.
 */
export function listSkippedMcpTools(
  skippedTools: readonly SkippedMcpTool[]
): readonly SkippedMcpToolListing[] {
  const occurrences = new Map<string, number>()
  return skippedTools.map((tool) => {
    const identity = `${tool.reason}\n${tool.name}`
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return { key: `${tool.reason}:${occurrence}:${tool.name}`, tool }
  })
}

/**
 * Formats what the backend's last read of the `mcp` group says.
 *
 * @param list - Lifecycle of the list of applied servers.
 * @returns Why the backend keeps the servers it applied last, or an empty
 * string when it applied the group or the list is not loaded.
 */
export function formatMcpSettingsOutcome(list: McpServerListState): string {
  return list.status === "loaded"
    ? MCP_SETTINGS_OUTCOME_TEXTS[list.settings]
    : ""
}

/** What one sentence of the MCP pane's status line is about. */
export type McpPaneNoteKind =
  | "backend-stopped"
  | "read-failed"
  | "settings-outcome"
  | "action-failed"
  | "save-failed"

/** One sentence of the MCP pane's status line. */
export type McpPaneNote = {
  /** What the sentence is about; at most one note has each kind. */
  readonly kind: McpPaneNoteKind
  /** The sentence; never empty. */
  readonly text: string
}

/**
 * Lists what the backend's answers say about the servers as a whole.
 *
 * @param facts - Backend status, the list, and the action failure.
 * @returns While the backend is not running, that it must be started;
 * otherwise why the list could not be read, why the backend keeps the
 * servers it applied last, and why the latest action could not be asked,
 * each with an empty sentence when it does not apply.
 */
function listMcpBackendNotes(facts: McpPaneFacts): readonly McpPaneNote[] {
  if (!facts.isBackendRunning) {
    return [{ kind: "backend-stopped", text: MCP_BACKEND_STOPPED_NOTE }]
  }
  const listError = facts.list.status === "failed" ? facts.list.error : ""
  return [
    { kind: "read-failed", text: listError },
    { kind: "settings-outcome", text: formatMcpSettingsOutcome(facts.list) },
    { kind: "action-failed", text: facts.actionFailure?.error ?? "" }
  ]
}

/**
 * Lists the sentences of the MCP pane's status line.
 *
 * @param facts - Backend status, the list, the action failure, the save,
 * and whether the editor is open.
 * @returns A frozen list of the notes that apply, in order: the backend's
 * notes, then a failed save while the editor is closed; empty while nothing
 * needs saying.
 */
export function listMcpPaneNotes(facts: McpPaneFacts): readonly McpPaneNote[] {
  const { saveState } = facts
  const saveError =
    !facts.isEditing && saveState.status === "failed" ? saveState.error : ""
  const saveNote: McpPaneNote = { kind: "save-failed", text: saveError }
  return Object.freeze(
    [...listMcpBackendNotes(facts), saveNote].filter((note) => note.text !== "")
  )
}

/** Request a Retry of the MCP pane sends again. */
export type McpPaneRetry = "sync" | "read"

/**
 * Chooses what Retry on the MCP pane sends again.
 *
 * @param facts - Backend status, the list, and the action failure.
 * @returns `sync` after the backend could not be asked to apply the saved
 * servers, whose answer is also the list; `read` after the list could not be
 * read; undefined while neither failed, after a failed reconnect, which its
 * server's button sends again, and while the backend is not running.
 */
export function findMcpPaneRetry(
  facts: McpPaneFacts
): McpPaneRetry | undefined {
  if (!facts.isBackendRunning) return undefined
  if (facts.actionFailure?.action === "sync") return "sync"
  return facts.list.status === "failed" ? "read" : undefined
}

/** One editor field with a problem, as the problem summary lists it. */
export type McpDraftProblemListing = {
  /** The field. */
  readonly field: McpServerDraftField
  /** The field's label. */
  readonly label: string
  /** The field's first problem. */
  readonly problem: string
}

/**
 * Formats the label of an editor field.
 *
 * @param field - Field of the editor.
 * @returns The label the field and the problem summary show.
 */
export function formatMcpDraftFieldLabel(field: McpServerDraftField): string {
  return MCP_DRAFT_FIELD_LABELS[field]
}

/**
 * Lists the editor fields that have a problem.
 *
 * @param problems - First problem of each field that has one.
 * @returns A frozen list in the order the editor shows the fields, each
 * with its label and problem; empty for a draft without problems.
 */
export function listMcpDraftProblems(
  problems: McpServerDraftProblems
): readonly McpDraftProblemListing[] {
  return Object.freeze(
    MCP_SERVER_DRAFT_FIELDS.flatMap((field) => {
      const problem = problems[field]
      if (problem === undefined) return []
      return [{ field, label: MCP_DRAFT_FIELD_LABELS[field], problem }]
    })
  )
}

/**
 * Formats the heading of the summary of a rejected save.
 *
 * @param count - Number of fields with a problem; the summary appears only
 * for two or more.
 * @returns `Fix N fields to save:`.
 */
export function formatMcpDraftProblemSummaryHeading(count: number): string {
  return `Fix ${count} fields to save:`
}

/**
 * Formats the label of a way to sign in.
 *
 * @param signIn - Way to sign in.
 * @returns `None` or `Token`.
 */
export function formatMcpSignInLabel(signIn: McpSignIn): string {
  return MCP_SIGN_IN_LABELS[signIn]
}

/**
 * Formats the note under the chosen way to sign in.
 *
 * @param signIn - Way to sign in.
 * @returns Who can use the server without a token, or how the token is sent
 * and saved.
 */
export function formatMcpSignInNote(signIn: McpSignIn): string {
  return MCP_SIGN_IN_NOTES[signIn]
}

/**
 * Formats the names the model calls a server's tools by, from a name as
 * typed.
 *
 * @param name - Server name as typed.
 * @returns `its tools arrive as mcp__<name>__…`, with `name` while the name
 * is empty.
 */
export function formatMcpToolNamePreview(name: string): string {
  const shownName = name.trim() === "" ? "name" : name.trim()
  return `its tools arrive as ${buildMcpToolNamePrefix(shownName)}…`
}

/**
 * Formats what the editor's kind tag says.
 *
 * @param serverName - Saved name of the edited server, or undefined for a
 * new one.
 * @returns `new server` or `editing · <name>`.
 */
export function formatMcpEditorKind(
  serverName: McpServerName | undefined
): string {
  return serverName === undefined ? "new server" : `editing · ${serverName}`
}

/**
 * Formats the editor's hint about saving from the keyboard.
 *
 * @param isNew - Whether the editor is open for a new server.
 * @returns How ⌘ Enter adds the server, or saves it and what follows.
 */
export function formatMcpEditorHint(isNew: boolean): string {
  return isNew
    ? "⌘ enter adds it"
    : "⌘ enter saves · it reconnects with the new settings"
}

/**
 * Formats what happened to a pasted config.
 *
 * @param parse - Outcome of filling the editor from the paste.
 * @returns That the fields were filled, from which server, or why they were
 * not.
 */
export function formatMcpServerJsonMessage(
  parse: McpServerJsonParse
): McpServerJsonMessage {
  if (parse.status === "invalid") {
    return {
      text: MCP_SERVER_JSON_PROBLEM_TEXTS[parse.problem],
      isFilled: false
    }
  }
  const serverName = parse.draft.name === "" ? "one server" : parse.draft.name
  const source =
    parse.serverCount > 1
      ? `first of ${parse.serverCount} servers · add the rest the same way`
      : serverName
  return { text: `filled from json · ${source}`, isFilled: true }
}

/** How one list of rows is shown in the editor. */
export type McpEntryListPresentation = {
  /** What one row is, in lowercase, such as `variable`. */
  readonly itemName: string
  /** Format of the names and how the values are saved, shown before entry. */
  readonly hint: string
  /** Example name, shown while a row's name is empty. */
  readonly namePlaceholder: string
}

/** How each list of rows is shown; a new list must add one. */
const MCP_ENTRY_LIST_PRESENTATIONS = Object.freeze({
  environment: Object.freeze({
    itemName: "variable",
    hint: "NAME: letters, digits, _ · values saved in plain text",
    namePlaceholder: "GITHUB_TOKEN"
  }),
  headers: Object.freeze({
    itemName: "header",
    hint: "optional · values saved in plain text",
    namePlaceholder: "X-Workspace"
  })
} satisfies Readonly<Record<McpDraftEntryList, McpEntryListPresentation>>)

/**
 * Gets how one list of rows is shown in the editor.
 *
 * @param list - List of rows.
 * @returns Its item name, hint, and example name.
 */
export function getMcpEntryListPresentation(
  list: McpDraftEntryList
): McpEntryListPresentation {
  return MCP_ENTRY_LIST_PRESENTATIONS[list]
}
