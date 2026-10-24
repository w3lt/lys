import {
  MAXIMUM_MCP_SERVER_TOOL_COUNT,
  type McpServerFailure,
  type McpServerList,
  type McpServerState,
  type McpServerStatus,
  type SkippedMcpTool,
  type SkippedMcpToolReason
} from "@lys/protocol"
import {
  MAXIMUM_MCP_SERVER_COUNT,
  type McpServerName,
  type McpServerSettings,
  type McpServerTransport
} from "@lys/share"

import {
  MCP_SERVER_DRAFT_FIELDS,
  type McpServerDraftField,
  type McpServerDraftProblems
} from "@/lib/models/mcp-server-draft"
import type {
  McpServerActionFailure,
  McpServerListState
} from "@/lib/store/mcp-servers"
import type { McpSettingsSaveState } from "@/lib/store/mcp-settings"

/** Tone of a server's state line. */
export type McpServerTone = "neutral" | "pending" | "success" | "danger"

/** A server's state as its row shows it. */
export type McpServerStatePresentation = {
  /** State line, or an empty string while there is nothing to say. */
  readonly text: string
  /** Tone of the state line. */
  readonly tone: McpServerTone
}

/** Facts a row's state line is drawn from. */
export type McpServerRowFacts = {
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** Lifecycle of the list of applied servers. */
  readonly list: McpServerListState
  /** Name of the server the row shows. */
  readonly serverName: McpServerName
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

/** Transports in the order the editor offers them. */
export const MCP_SERVER_TRANSPORTS: readonly McpServerTransport[] =
  Object.freeze(["stdio", "http"])

/** Label of each transport; a new transport must add one. */
const MCP_SERVER_TRANSPORT_LABELS = Object.freeze({
  stdio: "Command",
  http: "URL"
} satisfies Readonly<Record<McpServerTransport, string>>)

/** Why a server is not connected, as its row says it; a new reason must add one. */
const MCP_SERVER_FAILURE_TEXTS = Object.freeze({
  "start-failed":
    "Lys couldn't start the command. Check that it exists; use its full path.",
  closed: "The server closed the connection.",
  "timed-out": "The server didn't answer within 2 minutes.",
  unauthorized:
    "The server refused the request. Check the headers, such as Authorization.",
  unreachable: "Lys couldn't reach the server.",
  "http-error": "The server answered with an HTTP error.",
  "protocol-error": "The server's answer isn't valid MCP."
} satisfies Readonly<Record<McpServerFailure, string>>)

/** Why a tool of a server is not listed; a new reason must add one. */
const SKIPPED_MCP_TOOL_REASON_TEXTS = Object.freeze({
  "unsupported-name": "Its name is empty or too long to offer to a model.",
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

/** State line of a server while nothing is known about it. */
const NO_STATE: McpServerStatePresentation = Object.freeze({
  text: "",
  tone: "neutral"
})

/** State line of a saved server the backend has not applied. */
const NOT_APPLIED_STATE: McpServerStatePresentation = Object.freeze({
  text: "Not applied. Reconnect applies the saved servers.",
  tone: "neutral"
})

/** Note shown while the backend is not running. */
export const MCP_BACKEND_STOPPED_NOTE =
  "Start the backend in Settings → Runtime to connect to MCP servers."

/**
 * Formats the label of a transport.
 *
 * @param transport - How Lys talks to the server.
 * @returns `Command` or `URL`.
 */
export function formatMcpServerTransportLabel(
  transport: McpServerTransport
): string {
  return MCP_SERVER_TRANSPORT_LABELS[transport]
}

/**
 * Formats what a server's row says it runs or reaches.
 *
 * @param server - Saved server settings.
 * @returns The command followed by its arguments, separated by spaces, or
 * the URL. Environment values and headers, which can be secrets, are never
 * shown.
 */
export function formatMcpServerTarget(server: McpServerSettings): string {
  if (server.transport === "http") return server.url
  return [server.command, ...server.arguments].join(" ")
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
 * Formats the state line of a connected server.
 *
 * @param state - Connected state.
 * @returns `Connected · N tools`, followed by `· N skipped` when the backend
 * skipped some.
 */
function formatConnectedState(
  state: Extract<McpServerState, { readonly status: "connected" }>
): string {
  const connected = `Connected · ${formatToolCount(state.toolCount)}`
  const skippedCount = state.skippedTools.length
  return skippedCount === 0
    ? connected
    : `${connected} · ${skippedCount} skipped`
}

/**
 * Formats the state of an applied server.
 *
 * @param state - Connection state the backend reports.
 * @returns The state line and its tone: connecting, connected with its tool
 * count, or failed with why.
 */
export function formatMcpServerState(
  state: McpServerState
): McpServerStatePresentation {
  switch (state.status) {
    case "connecting":
      return { text: "Connecting…", tone: "pending" }
    case "connected":
      return { text: formatConnectedState(state), tone: "success" }
    case "failed":
      return {
        text: `Failed: ${MCP_SERVER_FAILURE_TEXTS[state.reason]}`,
        tone: "danger"
      }
  }
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
 * Formats the state line of a saved server's row.
 *
 * @param facts - Backend status, the list, and the server's name.
 * @returns Nothing while the backend is not running or the list is not
 * loaded; that the server is not applied when the backend does not list
 * it; otherwise its state.
 */
export function formatMcpServerRowState(
  facts: McpServerRowFacts
): McpServerStatePresentation {
  if (!facts.isBackendRunning || facts.list.status !== "loaded") return NO_STATE
  const status = findMcpServerStatus(facts.list, facts.serverName)
  return status === undefined
    ? NOT_APPLIED_STATE
    : formatMcpServerState(status.state)
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

/** One skipped tool as a server's row lists it. */
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

/**
 * Formats the count beside the servers heading.
 *
 * @param count - Number of saved servers.
 * @returns A label such as `2 of 16`.
 */
export function formatMcpServerCount(count: number): string {
  return `${count} of ${MAXIMUM_MCP_SERVER_COUNT}`
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

/** Note shown with the skipped tools of a server that has more than Lys reads. */
export const MCP_TOOL_LIST_CUT_NOTE = `The server lists more tools than Lys reads. Lys reads the first ${MAXIMUM_MCP_SERVER_TOOL_COUNT}.`

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
 * row's Reconnect sends again, and while the backend is not running.
 */
export function findMcpPaneRetry(
  facts: McpPaneFacts
): McpPaneRetry | undefined {
  if (!facts.isBackendRunning) return undefined
  if (facts.actionFailure?.action === "sync") return "sync"
  return facts.list.status === "failed" ? "read" : undefined
}

/** Label of each editor field; a new field must add one. */
const MCP_DRAFT_FIELD_LABELS = Object.freeze({
  name: "Name",
  command: "Command",
  arguments: "Arguments",
  environment: "Environment",
  url: "URL",
  headers: "Headers"
} satisfies Readonly<Record<McpServerDraftField, string>>)

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
