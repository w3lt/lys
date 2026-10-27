import type { BackendServerStatus } from "@/lib/store"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"
import type { LlmProviderTarget } from "./llm-provider-target"

/**
 * Whether model requests can reach the active provider, and why not.
 *
 * @remarks Ordered by prerequisite: the backend must answer before the
 * provider's status matters. The `lm-studio-` names predate other providers
 * and cover every provider.
 */
export type ModelRuntimeAvailability =
  | "backend-offline"
  | "lm-studio-connecting"
  | "lm-studio-unreachable"
  | "available"

/** Visual tone of the provider status indicator. */
export type LmStudioStatusTone = "active" | "pending" | "idle" | "danger"

/**
 * Formats the explanation shown wherever model features wait for an
 * unreachable provider.
 *
 * @param provider - Active provider.
 * @returns What to check: a server at an address, or a key and the network
 * for a hosted provider; then where to refresh.
 */
export function formatProviderUnreachableMessage(
  provider: LlmProviderTarget
): string {
  const check =
    provider.access === "address"
      ? `Start ${provider.name}, or check its address in Providers`
      : "Check its key in Providers and your network"
  return `${provider.name} is not reachable. ${check}, then press Refresh on its status in Runtime.`
}

/**
 * Calculates whether model requests can reach the active provider, and why
 * not.
 *
 * @param backendStatus - Store-owned backend lifecycle state.
 * @param lmStudioStatus - Latest published provider status.
 * @returns `available` only while the backend runs and the provider is
 * connected. An `unknown` status while the backend runs counts as connecting,
 * because the store reads it right after the backend becomes ready.
 */
export function calculateModelRuntimeAvailability(
  backendStatus: BackendServerStatus,
  lmStudioStatus: LmStudioStatus
): ModelRuntimeAvailability {
  if (backendStatus !== "running") return "backend-offline"
  switch (lmStudioStatus) {
    case "connected":
      return "available"
    case "unreachable":
      return "lm-studio-unreachable"
    case "unknown":
    case "connecting":
      return "lm-studio-connecting"
  }
}

/**
 * Formats the provider status card heading.
 *
 * @param lmStudioStatus - Latest published provider status.
 * @param provider - Active provider.
 * @returns The heading naming the provider and the connection state.
 */
export function formatLmStudioStatusLabel(
  lmStudioStatus: LmStudioStatus,
  provider: LlmProviderTarget
): string {
  switch (lmStudioStatus) {
    case "unknown":
      return `${provider.name} status unknown`
    case "connecting":
      return `Connecting to ${provider.name}`
    case "connected":
      return `${provider.name} connected`
    case "unreachable":
      return `${provider.name} not reachable`
  }
}

/**
 * Formats why the provider status is not known, for the backend's state.
 *
 * @param backendStatus - Store-owned backend lifecycle state.
 * @returns What the backend is doing while it is starting, stopping, or not
 * responding; the next step otherwise, which is starting a stopped backend
 * and refreshing against a running one.
 */
function formatUnknownLmStudioStatusReason(
  backendStatus: BackendServerStatus
): string {
  switch (backendStatus) {
    case "running":
      return "status unavailable · refresh to check"
    case "stopped":
      return "start the backend first"
    case "starting":
      return "waiting for the backend to start"
    case "stopping":
      return "the backend is stopping"
    case "unresponsive":
      return "the backend is not responding"
  }
}

/**
 * Formats where the provider is and the next step, shown under the provider
 * status heading.
 *
 * @param lmStudioStatus - Latest published provider status.
 * @param backendStatus - Store-owned backend lifecycle state.
 * @param provider - Active provider.
 * @returns The meta line, starting with the provider's location; an
 * `unknown` status adds why it is not known, which depends on the backend's
 * state, and an `unreachable` one what to check.
 */
export function formatLmStudioStatusMeta(
  lmStudioStatus: LmStudioStatus,
  backendStatus: BackendServerStatus,
  provider: LlmProviderTarget
): string {
  switch (lmStudioStatus) {
    case "unknown":
      return `${provider.location} · ${formatUnknownLmStudioStatusReason(backendStatus)}`
    case "connecting":
      return `${provider.location} · connecting`
    case "connected":
      return provider.location
    case "unreachable":
      return provider.access === "address"
        ? `${provider.location} · start ${provider.name}, then refresh`
        : `${provider.location} · check the key in Providers, then refresh`
  }
}

/**
 * Selects the provider status indicator tone.
 *
 * @param lmStudioStatus - Latest published provider status.
 * @returns The tone consumed by the status dot's styles.
 */
export function calculateLmStudioStatusTone(
  lmStudioStatus: LmStudioStatus
): LmStudioStatusTone {
  switch (lmStudioStatus) {
    case "unknown":
      return "idle"
    case "connecting":
      return "pending"
    case "connected":
      return "active"
    case "unreachable":
      return "danger"
  }
}
