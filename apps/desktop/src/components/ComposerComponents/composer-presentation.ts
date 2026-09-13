import type { BackendServerStatus } from "@/lib/store"
import type {
  ChatRequestState,
  ConversationOpenState
} from "@/lib/store/chat-view"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"

/**
 * Availability of the local generation runtime as the composer describes it.
 *
 * @remarks `no-model` is reachable only while the backend is running, so the
 * three states are ordered: the process must be up before weights can be.
 */
export type LocalRuntimeConnection = "ready" | "no-model" | "offline"

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
 * Derives the composer's view of local generation availability.
 *
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param isModelLoaded - Whether the selected model is known to be resident.
 * @returns The availability state the composer renders against.
 */
export function readLocalRuntimeConnection(
  backendStatus: BackendServerStatus,
  isModelLoaded: boolean
): LocalRuntimeConnection {
  if (backendStatus !== "running") return "offline"
  if (!isModelLoaded) return "no-model"

  return "ready"
}

/**
 * Formats the banner sentence explaining why generation is unavailable.
 *
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param backendAddress - Persisted backend origin named in the copy.
 * @param modelRuntime - Observed residency, including unavailable observations.
 * @returns The visible explanation for the current unavailable state.
 */
export function formatUnavailableRuntimeMessage(
  backendStatus: BackendServerStatus,
  backendAddress: string,
  modelRuntime: ModelRuntimeState
): string {
  switch (backendStatus) {
    case "starting":
      return `Starting the backend on ${backendAddress}…`
    case "stopping":
      return "Stopping the backend…"
    case "stopped":
      return `The backend is not running on ${backendAddress}.`
    case "running":
      if (modelRuntime.status === "unknown")
        return "The backend is up, but model state is unavailable."
      if (modelRuntime.status === "loading") return "Loading model weights…"
      if (modelRuntime.status === "unloading") return "Unloading model weights…"
      return "The backend is up, but no model is loaded."
  }
}

/**
 * Formats the banner's recovery action for the current runtime state.
 *
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param modelRuntime - Observed residency or current weight transition.
 * @returns The action label and whether it is currently actionable; a state
 * that is already transitioning offers no action to take.
 */
export function formatReconnectAction(
  backendStatus: BackendServerStatus,
  modelRuntime: ModelRuntimeState
): ReconnectAction {
  if (backendStatus === "stopped") {
    return { label: "Start backend", isEnabled: true }
  }
  if (backendStatus === "running" && modelRuntime.status === "unknown") {
    return { label: "Check models", isEnabled: true }
  }
  if (backendStatus === "running" && modelRuntime.status === "none") {
    return { label: "Load model", isEnabled: true }
  }

  return { label: "Working", isEnabled: false }
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
