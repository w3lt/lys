import type { LlmInfo } from "@lys/protocol"
import type { LlmModelReference, LlmProvider } from "@lys/share"

import type { SettingsPane } from "@/app/types"
import {
  buildModelDescriptor,
  type LocalModelDescriptor
} from "@/lib/models/inventory"
import {
  describeLlmProviderTarget,
  type LlmProviderTarget
} from "@/lib/models/llm-provider-target"
import type { ModelAvailability } from "@/lib/models/model-availability"
import {
  calculateProviderAvailability,
  formatModelReferenceLabel,
  listEnabledProviders,
  type ModelAvailabilitySource
} from "@/lib/models/provider-connection"
import type { BackendServerStatus } from "@/lib/store"
import {
  formatConversationAgentName,
  type ConversationAgent
} from "@/lib/store/agents/conversation-agent"
import type {
  ChatRequestState,
  ConversationOpenState
} from "@/lib/store/chat-view"
import type {
  ModelInventoryState,
  ModelRequestState
} from "@/lib/store/model-runtime"
import type { ProvidersSettings } from "@/lib/store/settings"

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

/**
 * The unavailable banner's recovery action: its label and what pressing it
 * does.
 */
export type ComposerBannerAction =
  | {
      /** Starts the stopped backend. */
      readonly kind: "start-backend"
      /** Label shown on the button. */
      readonly label: string
    }
  | {
      /** Opens one settings pane. */
      readonly kind: "open-settings"
      /** Label shown on the button. */
      readonly label: string
      /** Pane that fixes the missing prerequisite. */
      readonly pane: SettingsPane
    }
  | {
      /** Opens the composer's model menu, to choose another model. */
      readonly kind: "open-model-menu"
      /** Label shown on the button. */
      readonly label: string
    }
  | {
      /** Shows one model in the Model pane, where it is loaded. */
      readonly kind: "show-model"
      /** Label shown on the button. */
      readonly label: string
      /** Model to show. */
      readonly model: LlmModelReference
    }
  | {
      /** Nothing to do while the state already changes; the button is disabled. */
      readonly kind: "none"
      /** Label shown on the disabled button. */
      readonly label: string
    }

/** One model the composer's model menu offers. */
export type ComposerModelChoice = {
  /** The model. */
  readonly reference: LlmModelReference
  /** The model as its provider lists it, with display labels. */
  readonly model: LocalModelDescriptor
  /** Request in flight for the model's provider. */
  readonly request: ModelRequestState
  /** Radio value of the row, unique among the menu's rows. */
  readonly value: string
}

/** One turned-on provider's part of the composer's model menu. */
export type ComposerModelGroup =
  | {
      /** The provider lists models the menu offers. */
      readonly kind: "models"
      /** Provider the group is labelled with. */
      readonly provider: LlmProvider
      /** Its models, in inventory order. */
      readonly choices: readonly ComposerModelChoice[]
    }
  | {
      /** The provider lists no model now; a line says why. */
      readonly kind: "status"
      /** Provider the group is labelled with. */
      readonly provider: LlmProvider
      /** Why the provider lists no model. */
      readonly status: string
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
  /** Whether the saved settings turn any provider on. */
  readonly hasProviderOn: boolean
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
 * Formats the banner sentence for a model that is listed and not loaded.
 *
 * @param model - The conversation's model.
 * @param providerName - Name of its provider.
 * @param modelLoading - Who loads the provider's models.
 * @returns That Lys has not loaded the model, or that the provider does not
 * run it.
 */
function formatNotLoadedMessage(
  model: LlmModelReference,
  providerName: string,
  modelLoading: "lys" | "provider"
): string {
  return modelLoading === "lys"
    ? `${model.modelKey} isn't loaded in ${providerName}.`
    : `${providerName} isn't running ${model.modelKey}.`
}

/**
 * Formats the banner sentence while the backend runs.
 *
 * @param runtime - The conversation's model, its availability, its
 * provider, and whether any provider is on.
 * @returns The model's first missing prerequisite: no provider on, no model,
 * its provider off, connecting, or not reachable, its state unread, the
 * model not listed, not loaded, or in a load or unload.
 */
function formatRunningRuntimeMessage({
  model,
  availability,
  provider,
  hasProviderOn
}: ComposerModelState): string {
  if (model === null || availability === null) {
    return hasProviderOn
      ? "The backend is up, but no model is loaded."
      : "No provider is on."
  }
  switch (availability.status) {
    case "provider-off":
      return `${provider.name} is turned off.`
    case "provider-connecting":
      return `Connecting to ${provider.name}…`
    case "provider-unreachable":
      return `${provider.name} can't be reached on ${provider.location}.`
    case "backend-not-running":
    case "inventory-unread":
    case "inventory-failed":
      return "The backend is up, but model state is unavailable."
    case "not-listed":
      return `${model.modelKey} isn't on ${provider.name}.`
    case "not-loaded":
      return formatNotLoadedMessage(
        model,
        provider.name,
        availability.modelLoading
      )
    case "loading":
      return "Loading model weights…"
    case "unloading":
      return "Unloading model weights…"
    case "loaded":
      return `${model.modelKey} is loaded.`
  }
}

/** The banner action while the state already changes. */
const WORKING_ACTION: ComposerBannerAction = Object.freeze({
  kind: "none",
  label: "Working"
})

/** The banner action that opens the model menu. */
const CHOOSE_MODEL_ACTION: ComposerBannerAction = Object.freeze({
  kind: "open-model-menu",
  label: "Choose model"
})

/** The banner action that opens the Providers pane. */
const OPEN_PROVIDERS_ACTION: ComposerBannerAction = Object.freeze({
  kind: "open-settings",
  label: "Open Providers",
  pane: "providers"
})

/**
 * Finds the banner's recovery action for a model that is listed and not
 * loaded.
 *
 * @param model - The conversation's model.
 * @param modelLoading - Who loads its provider's models.
 * @returns Load, which shows the model in the Model pane, when Lys loads the
 * provider's models; otherwise Choose model, because the provider decides
 * what it runs.
 */
function findNotLoadedAction(
  model: LlmModelReference,
  modelLoading: "lys" | "provider"
): ComposerBannerAction {
  return modelLoading === "lys"
    ? { kind: "show-model", label: `Load ${model.modelKey}`, model }
    : CHOOSE_MODEL_ACTION
}

/**
 * Finds the banner's recovery action while the backend runs.
 *
 * @param runtime - The conversation's model, its availability, and whether
 * any provider is on.
 * @returns Open Providers while no provider is on or the model's provider is
 * off or not reachable; Choose model, which opens the model menu, without a
 * model or for one its provider does not list; Check models, which opens
 * the Model pane, while the inventory is unread; Load or Choose model for a
 * model that is not loaded; no action while the state already changes.
 */
function findRunningBannerAction({
  model,
  availability,
  hasProviderOn
}: ComposerModelState): ComposerBannerAction {
  if (model === null || availability === null)
    return hasProviderOn ? CHOOSE_MODEL_ACTION : OPEN_PROVIDERS_ACTION
  switch (availability.status) {
    case "provider-off":
    case "provider-unreachable":
      return OPEN_PROVIDERS_ACTION
    case "inventory-unread":
    case "inventory-failed":
      return { kind: "open-settings", label: "Check models", pane: "model" }
    case "not-listed":
      return CHOOSE_MODEL_ACTION
    case "not-loaded":
      return findNotLoadedAction(model, availability.modelLoading)
    case "backend-not-running":
    case "provider-connecting":
    case "loading":
    case "unloading":
    case "loaded":
      return WORKING_ACTION
  }
}

/**
 * Finds the banner's recovery action for the current runtime state.
 *
 * @param runtime - The backend, the conversation's model, its availability,
 * its provider, and whether any provider is on.
 * @returns Start backend for a stopped backend, Check backend, which opens
 * the Runtime pane, for one that does not respond, no action while it starts
 * or stops, and otherwise the action for the model's first missing
 * prerequisite. Nothing is ever sent to another provider instead.
 */
export function findComposerBannerAction(
  runtime: ComposerModelState
): ComposerBannerAction {
  switch (runtime.backendStatus) {
    case "stopped":
      return { kind: "start-backend", label: "Start backend" }
    case "unresponsive":
      return { kind: "open-settings", label: "Check backend", pane: "runtime" }
    case "starting":
    case "stopping":
      return WORKING_ACTION
    case "running":
      return findRunningBannerAction(runtime)
  }
}

/**
 * Builds the radio value of one model's row in the model menu.
 *
 * @param reference - Model the row offers.
 * @returns A value unique to the provider and key: a provider name never
 * contains a slash, so the first slash ends it.
 */
export function buildComposerModelChoiceValue(
  reference: LlmModelReference
): string {
  return `${reference.provider}/${reference.modelKey}`
}

/**
 * Builds one model the menu offers.
 *
 * @param provider - Provider that lists the model.
 * @param info - The model as the provider lists it.
 * @param request - Request in flight for the provider.
 * @returns The choice.
 */
function buildComposerModelChoice(
  provider: LlmProvider,
  info: LlmInfo,
  request: ModelRequestState
): ComposerModelChoice {
  const reference: LlmModelReference = { provider, modelKey: info.modelKey }
  const model = buildModelDescriptor(info)
  const value = buildComposerModelChoiceValue(reference)
  return { reference, model, request, value }
}

/**
 * Formats why a connected provider's group lists no model.
 *
 * @param inventory - The provider's inventory.
 * @param providerName - Name of the provider.
 * @returns That its models are being read, that the read failed, or that it
 * lists none.
 */
function formatInventoryMenuStatus(
  inventory: ModelInventoryState,
  providerName: string
): string {
  switch (inventory.status) {
    case "unavailable":
      return `Reading ${providerName}'s models…`
    case "failed":
      return `Lys couldn't read ${providerName}'s models.`
    case "ready":
      return `${providerName} lists no model.`
  }
}

/**
 * Formats why a turned-on provider cannot list models now.
 *
 * @param source - Backend state, the providers that are on, and every
 * provider's state.
 * @param provider - The provider, with its name and location.
 * @returns Why its models cannot be read, or null while it is connected.
 */
function formatProviderMenuStatus(
  source: ModelAvailabilitySource,
  provider: LlmProviderTarget
): string | null {
  switch (calculateProviderAvailability(source, provider.provider)) {
    case "backend-offline":
      return "The backend isn't running."
    case "provider-off":
      return `${provider.name} is turned off.`
    case "provider-connecting":
      return `Connecting to ${provider.name}…`
    case "provider-unreachable":
      return `${provider.name} can't be reached on ${provider.location}.`
    case "available":
      return null
  }
}

/**
 * Builds one turned-on provider's group of the model menu.
 *
 * @param source - Backend state, the providers that are on, and every
 * provider's state.
 * @param provider - The provider, with its name and location.
 * @returns Its models while it is connected and its inventory lists any;
 * otherwise a line saying why it lists none.
 */
function buildComposerModelGroup(
  source: ModelAvailabilitySource,
  provider: LlmProviderTarget
): ComposerModelGroup {
  const status = formatProviderMenuStatus(source, provider)
  if (status !== null)
    return { kind: "status", provider: provider.provider, status }
  const { inventory, request } = source.providerModels[provider.provider]
  if (inventory.status !== "ready" || inventory.models.length === 0) {
    return {
      kind: "status",
      provider: provider.provider,
      status: formatInventoryMenuStatus(inventory, provider.name)
    }
  }
  const choices = inventory.models.map((info) =>
    buildComposerModelChoice(provider.provider, info, request)
  )
  return { kind: "models", provider: provider.provider, choices }
}

/**
 * Lists the groups of the composer's model menu.
 *
 * @param source - Backend state, the providers that are on, and every
 * provider's state.
 * @param providers - Saved providers, for each provider's location.
 * @returns One group per turned-on provider, in provider order, each as its
 * own inventory arrives; empty while no provider is on.
 */
export function listComposerModelGroups(
  source: ModelAvailabilitySource,
  providers: ProvidersSettings
): readonly ComposerModelGroup[] {
  return listEnabledProviders(source.enabledProviders).map((provider) =>
    buildComposerModelGroup(
      source,
      describeLlmProviderTarget(provider, providers)
    )
  )
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
  const name = formatModelReferenceLabel(model)
  switch (availability?.status) {
    case "loading":
      return `${name} · loading`
    case "unloading":
      return `${name} · releasing`
    default:
      return name
  }
}
