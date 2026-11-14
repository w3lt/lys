import { LLM_PROVIDER_NAMES, type LlmProvider } from "@lys/share"

import type { ShownModelState } from "@/lib/hooks/conversationModel"
import type { ModelAvailability } from "@/lib/models/model-availability"
import type { ProviderAvailability } from "@/lib/models/provider-connection"
import type { BackendServerStatus } from "@/lib/store"
import type { McpServerListState } from "@/lib/store/mcp-servers"

import {
  formatEmailMailboxConnection,
  type EmailMailboxConnection
} from "./email-mailbox-connection"
import type { SettingsRailMarker, SettingsRailTone } from "./LeftBar"

/** The rail's one-line runtime summary and the color of its dot. */
export type RailStatus = {
  /** The summary. */
  readonly text: string
  /** Color of its dot. */
  readonly tone: SettingsRailTone
}

/** What the one-line runtime summary under the settings rail describes. */
export type RailStatusFacts = {
  /** Store-owned backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** The model a new conversation uses, with its availability. */
  readonly shownModel: ShownModelState
  /**
   * Provider the panes show, which the summary describes while there is no
   * model.
   */
  readonly shownProvider: LlmProvider
  /** Whether model requests can reach that provider. */
  readonly providerAvailability: ProviderAvailability
}

/**
 * Formats the rail summary for a backend that is not running.
 *
 * @param backendStatus - Store-owned backend lifecycle state other than
 * `running`.
 * @returns The backend state, matching the Runtime pane's backend card.
 */
function formatRailBackendStatus(
  backendStatus: Exclude<BackendServerStatus, "running">
): RailStatus {
  switch (backendStatus) {
    case "stopped":
      return { text: "backend stopped", tone: "neutral" }
    case "starting":
      return { text: "backend starting", tone: "pending" }
    case "stopping":
      return { text: "backend stopping", tone: "pending" }
    case "unresponsive":
      return { text: "backend not responding", tone: "danger" }
  }
}

/**
 * Formats the rail summary for a running backend from one provider's state.
 *
 * @param availability - Whether model requests can reach the provider.
 * @param providerName - Name of the provider.
 * @returns The provider state, matching the Runtime pane's provider card, or
 * that no model is loaded once the provider can be reached. A backend
 * offline, which the caller rules out first, reads as unavailable.
 */
function formatRailProviderStatus(
  availability: ProviderAvailability,
  providerName: string
): RailStatus {
  switch (availability) {
    case "provider-off":
      return { text: `backend up · ${providerName} is off`, tone: "neutral" }
    case "provider-connecting":
      return {
        text: `backend up · connecting to ${providerName}`,
        tone: "pending"
      }
    case "provider-unreachable":
      return {
        text: `backend up · ${providerName} not reachable`,
        tone: "danger"
      }
    case "available":
      return { text: "backend up · no model", tone: "neutral" }
    case "backend-offline":
      return { text: "backend up · model state unavailable", tone: "neutral" }
  }
}

/**
 * Formats the rail summary of the model a new conversation uses, once the
 * backend runs.
 *
 * @param availability - Whether the model can answer.
 * @param providerName - Name of the model's provider.
 * @returns The model's weights, or what keeps its provider from answering.
 */
function formatRailModelStatus(
  availability: ModelAvailability,
  providerName: string
): RailStatus {
  switch (availability.status) {
    case "loaded":
      return { text: "backend up · model loaded", tone: "success" }
    case "loading":
      return { text: "backend up · loading weights", tone: "pending" }
    case "unloading":
      return { text: "backend up · releasing weights", tone: "pending" }
    case "not-loaded":
      return { text: "backend up · no model", tone: "neutral" }
    case "not-listed":
      return { text: "backend up · model not listed", tone: "neutral" }
    case "provider-off":
    case "provider-connecting":
    case "provider-unreachable":
      return formatRailProviderStatus(availability.status, providerName)
    case "backend-not-running":
    case "inventory-unread":
    case "inventory-failed":
      return { text: "backend up · model state unavailable", tone: "neutral" }
  }
}

/**
 * Formats the one-line runtime summary shown under the settings rail.
 *
 * @param facts - The backend's state, the model a new conversation uses,
 * and the provider the panes show with whether model requests reach it.
 * @returns The rail's summary of the first missing prerequisite—the backend,
 * then the model's provider—or of the model's weights once both are
 * available, with the color of its dot: success only while the model is
 * loaded.
 */
export function formatRailStatus(facts: RailStatusFacts): RailStatus {
  const { backendStatus, shownModel } = facts
  if (backendStatus !== "running") return formatRailBackendStatus(backendStatus)
  if (shownModel.model === null || shownModel.availability === null) {
    return formatRailProviderStatus(
      facts.providerAvailability,
      LLM_PROVIDER_NAMES[facts.shownProvider]
    )
  }
  return formatRailModelStatus(
    shownModel.availability,
    LLM_PROVIDER_NAMES[shownModel.model.provider]
  )
}

/**
 * Builds the MCP entry's marker.
 *
 * @param list - The servers the backend applied, with their states.
 * @returns A danger dot while a listed server failed, and otherwise null.
 */
export function buildMcpRailMarker(
  list: McpServerListState
): SettingsRailMarker | null {
  if (list.status !== "loaded") return null
  const hasFailedServer = list.servers.some(
    (server) => server.state.status === "failed"
  )
  return hasFailedServer
    ? { kind: "dot", tone: "danger", label: "a server needs attention" }
    : null
}

/**
 * Builds the marker of the Lys pane's Email section.
 *
 * @param connection - Whether Lys's mailbox is set up, switched on, and
 * served.
 * @returns `Not set up` without an account; otherwise a dot colored and
 * named by the connection, such as `connected`.
 */
export function buildLysEmailRailMarker(
  connection: EmailMailboxConnection
): SettingsRailMarker {
  const { label, tone } = formatEmailMailboxConnection(connection)
  if (connection === "not-set-up") return { kind: "text", label }
  return { kind: "dot", tone, label: label.toLowerCase() }
}
