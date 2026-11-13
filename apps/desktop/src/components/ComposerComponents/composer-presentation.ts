import { LLM_PROVIDER_NAMES, type LlmModelReference } from "@lys/share"

import type { SettingsPane } from "@/app/types"
import type { LlmProviderTarget } from "@/lib/models/llm-provider-target"
import type { ModelAvailability } from "@/lib/models/model-availability"
import type { BackendServerStatus } from "@/lib/store"
import {
  formatConversationAgentName,
  type ConversationAgent
} from "@/lib/store/agents/conversation-agent"
import type {
  ChatRequestState,
  ConversationOpenState
} from "@/lib/store/chat-view"

/**
 * Chat work that keeps the composer from sending.
 *
 * @remarks `awaiting-reply` lasts while a reply is awaited or streams, until
 * the reply is final; a title that may still arrive after the reply does not
 * keep the composer from sending. `opening-conversation` lasts while a stored
 * conversation is read to replace the shown one.
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
 * Whether the conversation's model can answer, as the composer describes it.
 *
 * @remarks Ordered by prerequisite: the backend must answer, then the
 * model's provider must be on and connected, then the model must be loaded.
 */
export type LocalRuntimeConnection =
  "ready" | "no-model" | "provider-unavailable" | "offline"

/** The model the composer's next message goes to, as the banner explains it. */
export type ComposerModelState = {
  /** Store-owned backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** The model, or null when there is none. */
  readonly model: LlmModelReference | null
  /** Its availability, or null when there is no model. */
  readonly availability: ModelAvailability | null
  /** The model's provider, named with its location in the copy. */
  readonly provider: LlmProviderTarget
}

/** Runtime facts explained by the composer's unavailable banner. */
export type UnavailableRuntimeState = ComposerModelState & {
  /** Persisted backend origin named in the copy. */
  readonly backendAddress: string
}

/**
 * Calculates whether the conversation's model can answer, as the composer
 * describes it.
 *
 * @param backendStatus - Store-owned backend lifecycle state.
 * @param availability - Availability of the conversation's model, or null
 * when there is none.
 * @returns The first missing prerequisite, or `ready` only while the model's
 * availability is `loaded`; no other model answers in its place.
 */
export function calculateLocalRuntimeConnection(
  backendStatus: BackendServerStatus,
  availability: ModelAvailability | null
): LocalRuntimeConnection {
  if (backendStatus !== "running") return "offline"
  switch (availability?.status) {
    case "loaded":
      return "ready"
    case "backend-not-running":
      return "offline"
    case "provider-off":
    case "provider-connecting":
    case "provider-unreachable":
      return "provider-unavailable"
    default:
      return "no-model"
  }
}

/**
 * Formats the banner sentence explaining why generation is unavailable.
 *
 * @param runtime - Backend, model, and provider facts to explain.
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
      return formatRunningRuntimeMessage(runtime)
  }
}

/**
 * Formats the banner sentence while the backend runs.
 *
 * @param runtime - The conversation's model, its availability, and its
 * provider.
 * @returns The model's first missing prerequisite: no model, its provider
 * off, connecting, or not reachable, its state unread, the model not listed,
 * not loaded, or in a load or unload.
 */
function formatRunningRuntimeMessage({
  model,
  availability,
  provider
}: ComposerModelState): string {
  if (model === null || availability === null) {
    return "The backend is up, but no model is loaded."
  }
  switch (availability.status) {
    case "provider-off":
      return `${provider.name} is turned off.`
    case "provider-connecting":
      return `Connecting to ${provider.name} on ${provider.location}…`
    case "provider-unreachable":
      return `${provider.name} is not reachable on ${provider.location}.`
    case "backend-not-running":
    case "inventory-unread":
    case "inventory-failed":
      return "The backend is up, but model state is unavailable."
    case "not-listed":
      return `${provider.name} does not list ${model.modelKey}.`
    case "not-loaded":
      return `${model.modelKey} is not loaded in ${provider.name}.`
    case "loading":
      return "Loading model weights…"
    case "unloading":
      return "Unloading model weights…"
    case "loaded":
      return `${model.modelKey} is loaded.`
  }
}

/**
 * Formats the banner's recovery action for the current runtime state.
 *
 * @param runtime - The backend, the conversation's model, its availability,
 * and its provider.
 * @returns The action for the first missing prerequisite; a state that is
 * already transitioning offers no action. A provider that is off or not
 * reachable is checked in Providers. With the model not in memory, the
 * action loads it when its provider lets Lys load models, and chooses one
 * otherwise.
 */
export function formatReconnectAction(
  runtime: ComposerModelState
): ReconnectAction {
  const { backendStatus, availability, provider } = runtime
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
  if (availability === null) return { label: "Choose model", isEnabled: true }
  switch (availability.status) {
    case "provider-off":
      return { label: "Open Providers", isEnabled: true }
    case "provider-unreachable":
      return { label: `Check ${provider.name}`, isEnabled: true }
    case "inventory-unread":
    case "inventory-failed":
      return { label: "Check models", isEnabled: true }
    case "not-listed":
      return { label: "Choose model", isEnabled: true }
    case "not-loaded":
      return {
        label:
          availability.modelLoading === "lys" ? "Load model" : "Choose model",
        isEnabled: true
      }
    case "backend-not-running":
    case "provider-connecting":
    case "loading":
    case "unloading":
    case "loaded":
      return workingAction
  }
}

/**
 * Finds the settings pane the banner's recovery action opens.
 *
 * @param availability - Availability of the conversation's model, or null
 * when there is none.
 * @returns Providers for a provider that is off, connecting, or not
 * reachable; Runtime while the backend does not run; Model otherwise, which
 * owns inventory and loading.
 */
export function findReconnectSettingsPane(
  availability: ModelAvailability | null
): SettingsPane {
  switch (availability?.status) {
    case "provider-off":
    case "provider-connecting":
    case "provider-unreachable":
      return "providers"
    case "backend-not-running":
      return "runtime"
    default:
      return "model"
  }
}

/**
 * Determines which chat work, if any, keeps the composer from sending.
 *
 * @param request - Authoritative chat request lifecycle.
 * @param conversationOpen - Authoritative stored-conversation open lifecycle.
 * @returns Opening while a stored conversation is read, awaiting while a reply
 * is awaited or streamed, and idle otherwise, including after the reply
 * completed while its stream stays open for a title.
 */
export function calculateComposerActivity(
  request: ChatRequestState,
  conversationOpen: ConversationOpenState
): ComposerActivity {
  if (conversationOpen.status === "opening") return "opening-conversation"

  switch (request.status) {
    case "idle":
    case "reply-completed":
      return "idle"
    case "awaiting-turn":
    case "reply-streaming":
      return "awaiting-reply"
  }
}

/**
 * Formats the composer textarea placeholder.
 *
 * @param connection - Whether the conversation's model can answer.
 * @param activity - Chat work that keeps the composer from sending.
 * @param agent - Agent that answers the next message.
 * @param providerName - Name of the model's provider, or null when there is
 * no model.
 * @returns The placeholder shown while the field is empty: what the composer
 * waits on, that a conversation whose agent was deleted is read-only, or an
 * invitation naming the agent.
 */
export function formatComposerPlaceholder(
  connection: LocalRuntimeConnection,
  activity: ComposerActivity,
  agent: ConversationAgent,
  providerName: string | null
): string {
  if (connection === "offline") return "Waiting on the backend…"
  if (connection !== "ready") return `Waiting on ${providerName ?? "a model"}…`
  if (agent.status === "deleted") return "This conversation is read-only."

  switch (activity) {
    case "idle":
      return `Say something to ${formatConversationAgentName(agent)}`
    case "awaiting-reply":
      return "Keep typing — Send unlocks when the reply ends."
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
 * Formats how the composer names a model.
 *
 * @param model - Model to name.
 * @returns Its key and its provider's name, such as `qwen3-8b · LM Studio`,
 * so the same key on two providers reads as two models.
 */
export function formatComposerModelName(model: LlmModelReference): string {
  return `${model.modelKey} · ${LLM_PROVIDER_NAMES[model.provider]}`
}

/**
 * Formats the model label shown beside the composer's weights indicator.
 *
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param model - The model the next message goes to, or null when there is
 * none.
 * @param availability - Its availability, or null when there is no model.
 * @returns The label naming the process transition, or the model with any
 * load or unload it is in. A transition is named in words so the trigger
 * does not rest on its indicator tone alone while the menu is closed.
 */
export function formatComposerModelLabel(
  backendStatus: BackendServerStatus,
  model: LlmModelReference | null,
  availability: ModelAvailability | null
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
      break
  }
  if (model === null) return "no model selected"
  const name = formatComposerModelName(model)
  switch (availability?.status) {
    case "loading":
      return `${name} · loading`
    case "unloading":
      return `${name} · releasing`
    default:
      return name
  }
}
