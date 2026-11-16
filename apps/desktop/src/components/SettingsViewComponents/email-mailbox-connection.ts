import type { McpServerState } from "@lys/protocol"
import type { EmailAccount } from "@lys/share"

import type { McpServerListState } from "@/lib/store/mcp-servers"

import type { SettingsRailTone } from "./LeftBar"

/**
 * Whether a mailbox is set up, switched on, and served: `not-set-up`
 * without a saved account; `switched-off` while the person switched it
 * off; then the email server's state in the backend: `connected`,
 * `connecting`, `needs-attention` once it failed, and `not-connected`
 * while the backend does not run, its states were not read, or the server
 * is off.
 */
export type EmailMailboxConnection =
  | "not-set-up"
  | "switched-off"
  | "not-connected"
  | "connecting"
  | "connected"
  | "needs-attention"

/** What decides a mailbox's connection. */
export type EmailMailboxConnectionFacts = {
  /** The mailbox's saved account, or null. */
  readonly account: EmailAccount | null
  /** Whether the person switched the mailbox on. */
  readonly isMailboxOn: boolean
  /** Whether the backend is running. */
  readonly isBackendRunning: boolean
  /** The backend's states of the MCP servers. */
  readonly serverList: McpServerListState
}

/** A connection in words, with the color of its dot. */
export type EmailMailboxConnectionLabel = {
  /** Short state, such as `Connected`. */
  readonly label: string
  /** Color of its dot. */
  readonly tone: SettingsRailTone
}

/** Each email server state, as the connection of a mailbox it serves. */
const SERVER_STATE_CONNECTIONS = Object.freeze({
  connected: "connected",
  connecting: "connecting",
  failed: "needs-attention",
  off: "not-connected"
} satisfies Readonly<Record<McpServerState["status"], EmailMailboxConnection>>)

/** Each connection in words, with the color of its dot. */
const CONNECTION_LABELS = Object.freeze({
  "not-set-up": { label: "Not set up", tone: "neutral" },
  "switched-off": { label: "Switched off", tone: "neutral" },
  "not-connected": { label: "Not connected", tone: "neutral" },
  connecting: { label: "Connecting", tone: "pending" },
  connected: { label: "Connected", tone: "success" },
  "needs-attention": { label: "Needs attention", tone: "danger" }
} satisfies Readonly<
  Record<EmailMailboxConnection, EmailMailboxConnectionLabel>
>)

/**
 * Finds whether a mailbox is set up, switched on, and served.
 *
 * @param facts - The account, the switch, the backend, and the servers'
 * states.
 * @returns The connection; only the email server's state in a running
 * backend makes a switched-on mailbox connected, connecting, or in need of
 * attention.
 */
export function findEmailMailboxConnection(
  facts: EmailMailboxConnectionFacts
): EmailMailboxConnection {
  if (facts.account === null) return "not-set-up"
  if (!facts.isMailboxOn) return "switched-off"
  if (!facts.isBackendRunning || facts.serverList.status !== "loaded") {
    return "not-connected"
  }
  const emailServer = facts.serverList.servers.find(
    (server) => server.isBuiltIn && server.name === "email"
  )
  return emailServer === undefined
    ? "not-connected"
    : SERVER_STATE_CONNECTIONS[emailServer.state.status]
}

/**
 * Formats a mailbox's connection.
 *
 * @param connection - The connection.
 * @returns Its words and the color of its dot.
 */
export function formatEmailMailboxConnection(
  connection: EmailMailboxConnection
): EmailMailboxConnectionLabel {
  return CONNECTION_LABELS[connection]
}
