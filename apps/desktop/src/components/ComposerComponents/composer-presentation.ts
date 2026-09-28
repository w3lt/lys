import {
  calculateModelRuntimeAvailability,
  LM_STUDIO_ADDRESS
} from "@/lib/models/lm-studio-connection"
import { findEligibleChatModel } from "@/lib/models/model-residency"
import type { BackendServerStatus } from "@/lib/store"
import type {
  ChatRequestState,
  ConversationOpenState
} from "@/lib/store/chat-view"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"

/**
 * Chat work that keeps the composer from sending.
 *
 * @remarks `awaiting-reply` lasts until the whole request settles, including a
 * title that may arrive after the reply; `opening-conversation` lasts while a
 * stored conversation is read to replace the shown one.
 */
export type ComposerActivity =
  "idle" | "awaiting-reply" | "opening-conversation"

/** Visible copy and enablement for the offline banner's recovery action. */
export type ReconnectAction = {
  /** Label shown on the button. */
  readonly label: string
  /** Whether the action can be taken in the current runtime state. */
  readonly isEnabled: boolean
}

/**
 * Availability of the local generation runtime as the composer describes it.
 *
 * @remarks Ordered by prerequisite: the backend must answer, then LM Studio
 * must be connected, then weights must be loaded.
 */
export type LocalRuntimeConnection =
  "ready" | "no-model" | "provider-unavailable" | "offline"

/** Runtime facts explained by the composer's unavailable banner. */
export type UnavailableRuntimeState = {
  /** Store-owned backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** Persisted backend origin named in the copy. */
  readonly backendAddress: string
  /** Latest published LM Studio status. */
  readonly lmStudioStatus: LmStudioStatus
  /** Observed residency, including unavailable observations. */
  readonly modelRuntime: ModelRuntimeState
}

/**
 * Calculates the composer's view of local generation availability.
 *
 * @param backendStatus - Store-owned backend lifecycle state.
 * @param lmStudioStatus - Latest published LM Studio status.
 * @param modelRuntime - Current validated residency projection.
 * @returns The first missing prerequisite, or `ready` when
 * {@link findEligibleChatModel} finds a loaded model.
 */
export function calculateLocalRuntimeConnection(
  backendStatus: BackendServerStatus,
  lmStudioStatus: LmStudioStatus,
  modelRuntime: ModelRuntimeState
): LocalRuntimeConnection {
  switch (calculateModelRuntimeAvailability(backendStatus, lmStudioStatus)) {
    case "backend-offline":
      return "offline"
    case "lm-studio-connecting":
    case "lm-studio-unreachable":
      return "provider-unavailable"
    case "available":
      return findEligibleChatModel(backendStatus, modelRuntime) === null
        ? "no-model"
        : "ready"
  }
}

/**
 * Formats the banner sentence explaining why generation is unavailable.
 *
 * @param runtime - Backend, LM Studio, and residency facts to explain.
 * @returns The visible explanation naming the first missing prerequisite.
 */
export function formatUnavailableRuntimeMessage(
  runtime: UnavailableRuntimeState
): string {
  switch (runtime.backendStatus) {
    case "starting":
      return `Starting the backend on ${runtime.backendAddress}…`
    case "stopping":
      return "Stopping the backend…"
    case "stopped":
      return `The backend is not running on ${runtime.backendAddress}.`
    case "unresponsive":
      return `The backend is not responding on ${runtime.backendAddress}.`
    case "running":
      return formatRunningRuntimeMessage(
        runtime.lmStudioStatus,
        runtime.modelRuntime
      )
  }
}

/**
 * Formats the banner sentence while the backend runs.
 *
 * @param lmStudioStatus - Latest published LM Studio status.
 * @param modelRuntime - Observed residency or current weight transition.
 * @returns The LM Studio problem when it is not connected, otherwise the
 * weights problem.
 */
function formatRunningRuntimeMessage(
  lmStudioStatus: LmStudioStatus,
  modelRuntime: ModelRuntimeState
): string {
  if (lmStudioStatus === "unreachable") {
    return `LM Studio is not reachable on ${LM_STUDIO_ADDRESS}.`
  }
  if (lmStudioStatus !== "connected") {
    return `Connecting to LM Studio on ${LM_STUDIO_ADDRESS}…`
  }
  if (modelRuntime.status === "unknown") {
    return "The backend is up, but model state is unavailable."
  }
  if (modelRuntime.status === "loading") return "Loading model weights…"
  if (modelRuntime.status === "unloading") return "Unloading model weights…"
  return "The backend is up, but no model is loaded."
}

/**
 * Formats the banner's recovery action for the current runtime state.
 *
 * @param backendStatus - Store-owned backend lifecycle state.
 * @param lmStudioStatus - Latest published LM Studio status.
 * @param modelRuntime - Observed residency or current weight transition.
 * @returns The action for the first missing prerequisite; a state that is
 * already transitioning offers no action.
 */
export function formatReconnectAction(
  backendStatus: BackendServerStatus,
  lmStudioStatus: LmStudioStatus,
  modelRuntime: ModelRuntimeState
): ReconnectAction {
  const workingAction = Object.freeze({
    label: "Working",
    isEnabled: false
  } satisfies ReconnectAction)
  if (backendStatus === "stopped") {
    return { label: "Start backend", isEnabled: true }
  }
  if (backendStatus === "unresponsive") {
    return { label: "Check backend", isEnabled: true }
  }
  if (backendStatus !== "running") return workingAction
  if (lmStudioStatus === "unreachable") {
    return { label: "Check LM Studio", isEnabled: true }
  }
  if (lmStudioStatus !== "connected") return workingAction
  if (modelRuntime.status === "unknown") {
    return { label: "Check models", isEnabled: true }
  }
  if (modelRuntime.status === "none") {
    return { label: "Load model", isEnabled: true }
  }
  return workingAction
}

/**
 * Determines which chat work, if any, keeps the composer from sending.
 *
 * @param request - Authoritative chat request lifecycle.
 * @param conversationOpen - Authoritative stored-conversation open lifecycle.
 * @returns Opening while a stored conversation is read, awaiting while any
 * request is active, and idle otherwise.
 */
export function calculateComposerActivity(
  request: ChatRequestState,
  conversationOpen: ConversationOpenState
): ComposerActivity {
  if (conversationOpen.status === "opening") return "opening-conversation"

  return request.status === "idle" ? "idle" : "awaiting-reply"
}

/**
 * Formats the composer textarea placeholder.
 *
 * @param connection - Current local generation availability.
 * @param activity - Chat work that keeps the composer from sending.
 * @returns The placeholder shown while the field is empty.
 */
export function formatComposerPlaceholder(
  connection: LocalRuntimeConnection,
  activity: ComposerActivity
): string {
  if (connection === "offline") return "Waiting on the backend…"
  if (connection !== "ready") return "Waiting on LM Studio…"

  switch (activity) {
    case "idle":
      return "Say something to Lys"
    case "awaiting-reply":
      return "Keep typing — Send unlocks when she stops."
    case "opening-conversation":
      return "Opening a past conversation…"
  }
}

/**
 * Formats the status shown in the composer's meta row.
 *
 * @param activity - Chat work that keeps the composer from sending.
 * @returns Progress text for active work, or empty text when idle.
 */
export function formatComposerActivity(activity: ComposerActivity): string {
  switch (activity) {
    case "idle":
      return ""
    case "awaiting-reply":
      return "Generating…"
    case "opening-conversation":
      return "Opening…"
  }
}

/**
 * Formats the model label shown beside the composer's weights indicator.
 *
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param modelRuntime - Current weight residency state.
 * @param modelName - Persisted default model identifier, when one is chosen.
 * @returns The label naming the process transition, the weight transition, or
 * the weights themselves. A weight transition is named in words so the trigger
 * does not rest on its indicator tone alone while the menu is closed.
 */
export function formatComposerModelLabel(
  backendStatus: BackendServerStatus,
  modelRuntime: ModelRuntimeState,
  modelName: string | null
): string {
  switch (backendStatus) {
    case "starting":
      return "starting backend…"
    case "stopping":
      return "stopping…"
    case "stopped":
      return "backend stopped"
    case "unresponsive":
      return "backend not responding"
    case "running":
      return formatRunningModelLabel(modelRuntime, modelName)
  }
}

/**
 * Formats the weights label used while the backend process is up.
 *
 * @param modelRuntime - Current weight residency state.
 * @param modelName - Persisted default model identifier, when one is chosen.
 * @returns The weights named, with any transition they are currently in.
 */
function formatRunningModelLabel(
  modelRuntime: ModelRuntimeState,
  modelName: string | null
): string {
  switch (modelRuntime.status) {
    case "loading":
      return `${modelRuntime.modelKey} · loading`
    case "unloading":
      return `${modelRuntime.modelKey} · releasing`
    case "loaded":
      return modelRuntime.modelKey
    case "unknown":
      return "model state unavailable"
    case "none":
      return modelName ?? "no model selected"
  }
}
