import { LMSTUDIO_HOST, LMSTUDIO_PORT } from "@lys/protocol"
import type { BackendServerStatus } from "@/lib/store"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"

/** LM Studio address the backend connects to, as shown to the user. */
export const LM_STUDIO_ADDRESS = `${LMSTUDIO_HOST}:${LMSTUDIO_PORT}`

/** Explanation shown wherever model features wait for an unreachable LM Studio. */
export const LM_STUDIO_UNREACHABLE_MESSAGE =
  "LM Studio is not reachable. Start LM Studio, then press Refresh on its status in Runtime."

/**
 * Whether model requests can reach LM Studio, and why not.
 *
 * @remarks Ordered by prerequisite: the backend must answer before the LM
 * Studio status matters.
 */
export type ModelRuntimeAvailability =
  | "backend-offline"
  | "lm-studio-connecting"
  | "lm-studio-unreachable"
  | "available"

/** Visual tone of the LM Studio status indicator. */
export type LmStudioStatusTone = "active" | "pending" | "idle" | "danger"

/**
 * Calculates whether model requests can reach LM Studio, and why not.
 *
 * @param backendStatus - Store-owned backend lifecycle state.
 * @param lmStudioStatus - Latest published LM Studio status.
 * @returns `available` only while the backend runs and LM Studio is
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
 * Formats the LM Studio card heading.
 *
 * @param lmStudioStatus - Latest published LM Studio status.
 * @returns The heading naming the connection state.
 */
export function formatLmStudioStatusLabel(
  lmStudioStatus: LmStudioStatus
): string {
  switch (lmStudioStatus) {
    case "unknown":
      return "LM Studio status unknown"
    case "connecting":
      return "Connecting to LM Studio"
    case "connected":
      return "LM Studio connected"
    case "unreachable":
      return "LM Studio not reachable"
  }
}

/**
 * Formats the address and next step shown under the LM Studio heading.
 *
 * @param lmStudioStatus - Latest published LM Studio status.
 * @param backendStatus - Store-owned backend lifecycle state.
 * @returns The meta line; an `unknown` status names starting the backend when
 * it is not running, and refreshing otherwise.
 */
export function formatLmStudioStatusMeta(
  lmStudioStatus: LmStudioStatus,
  backendStatus: BackendServerStatus
): string {
  switch (lmStudioStatus) {
    case "unknown":
      return backendStatus === "running"
        ? `${LM_STUDIO_ADDRESS} · status unavailable · refresh to check`
        : `${LM_STUDIO_ADDRESS} · start the backend first`
    case "connecting":
      return `${LM_STUDIO_ADDRESS} · connecting`
    case "connected":
      return LM_STUDIO_ADDRESS
    case "unreachable":
      return `${LM_STUDIO_ADDRESS} · start LM Studio, then refresh`
  }
}

/**
 * Selects the LM Studio status indicator tone.
 *
 * @param lmStudioStatus - Latest published LM Studio status.
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
