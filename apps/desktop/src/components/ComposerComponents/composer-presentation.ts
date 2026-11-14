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
import {
  findLoadedModelInfo,
  type ModelAvailability
} from "@/lib/models/model-availability"
import {
  calculateProviderReadiness,
  formatModelReferenceLabel,
  listEnabledProviders,
  type ModelAvailabilitySource,
  type ProviderReadiness
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
  ModelRequestState,
  ProviderModelStates
} from "@/lib/store/model-runtime"
import type { LysSettings } from "@/lib/store/settings"

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
      /** Shows one model in the Models pane, where it is loaded. */
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
 * model's provider must be on, have its key, and be connected, then the
 * model must be loaded.
 */
export type LocalRuntimeConnection =
  "ready" | "no-model" | "provider-unavailable" | "offline"

/** The application state the composer's banner and model menu read. */
export type ComposerRuntime = {
  /** Store-owned backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** Saved providers, which are on and where, and saved keys. */
  readonly settings: Pick<LysSettings, "providers" | "secrets">
  /** What the desktop knows of every provider. */
  readonly providerModels: ProviderModelStates
}

/** A provider the composer names, and whether it can answer. */
export type ComposerProviderState = {
  /** The provider, named with its location in the copy. */
  readonly target: LlmProviderTarget
  /** Whether it can answer now, a missing key counted. */
  readonly readiness: ProviderReadiness
}

/** The model the composer's next message goes to, as the banner explains it. */
export type ComposerModelState = {
  /** Store-owned backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** The model, or null when there is none. */
  readonly model: LlmModelReference | null
  /** Its availability, or null when there is no model. */
  readonly availability: ModelAvailability | null
  /**
   * The provider the composer names: the model's provider; without a
   * model, the first turned-on provider, in provider order, while no
   * turned-on provider can answer. Null without a model while one can
   * answer or none is on.
   */
  readonly provider: ComposerProviderState | null
  /** Whether the saved settings turn any provider on. */
  readonly hasProviderOn: boolean
}

/** Runtime facts explained by the composer's unavailable banner. */
export type UnavailableRuntimeState = ComposerModelState & {
  /** Persisted backend origin named in the copy. */
  readonly backendAddress: string
}

/** Why a provider the composer names cannot answer. */
type UnavailableProviderReadiness = Exclude<ProviderReadiness, "available">

/** The banner sentence while some provider can answer and no model is set. */
const NO_MODEL_LOADED_MESSAGE = "The backend is up, but no model is loaded."

/**
 * Builds the state whether a provider or a model can answer depends on.
 *
 * @param runtime - Backend state, saved settings, and every provider's
 * state.
 * @returns The backend's state, the providers that are on, and every
 * provider's state.
 */
function buildAvailabilitySource(
  runtime: ComposerRuntime
): ModelAvailabilitySource {
  return {
    backendStatus: runtime.backendStatus,
    enabledProviders: runtime.settings.providers.enabled,
    providerModels: runtime.providerModels
  }
}

/**
 * Describes one provider as the composer names it.
 *
 * @param runtime - Backend state, saved settings, and every provider's
 * state.
 * @param provider - Provider to describe, whether on or off.
 * @returns The provider with where it is reached, and whether it can answer
 * now, a missing key counted.
 */
function describeComposerProvider(
  runtime: ComposerRuntime,
  provider: LlmProvider
): ComposerProviderState {
  return {
    target: describeLlmProviderTarget(provider, runtime.settings.providers),
    readiness: calculateProviderReadiness(
      buildAvailabilitySource(runtime),
      runtime.settings.secrets,
      provider
    )
  }
}

/**
 * Lists every turned-on provider as the composer names it.
 *
 * @param runtime - Backend state, saved settings, and every provider's
 * state.
 * @returns One state per turned-on provider, in provider order.
 */
function listComposerProviders(
  runtime: ComposerRuntime
): ComposerProviderState[] {
  return listEnabledProviders(runtime.settings.providers.enabled).map(
    (provider) => describeComposerProvider(runtime, provider)
  )
}

/**
 * Finds the provider the composer names while there is no model.
 *
 * @param runtime - Backend state, saved settings, and every provider's
 * state.
 * @returns The first turned-on provider, in provider order, while none can
 * answer, since then no model can be chosen until it can; null while one
 * can answer or none is on.
 */
function findUnavailableProvider(
  runtime: ComposerRuntime
): ComposerProviderState | null {
  const providers = listComposerProviders(runtime)
  if (providers.some((provider) => provider.readiness === "available"))
    return null
  return providers[0] ?? null
}

/**
 * Builds what the composer's banner, placeholder, and Send read of the
 * conversation's model.
 *
 * @param runtime - Backend state, saved settings, and every provider's
 * state.
 * @param shown - The conversation's model and its availability.
 * @returns The model with its provider, or, without a model, the turned-on
 * provider that keeps every model from answering, if any.
 */
export function buildComposerModelState(
  runtime: ComposerRuntime,
  shown: Pick<ComposerModelState, "model" | "availability">
): ComposerModelState {
  const { model, availability } = shown
  return {
    backendStatus: runtime.backendStatus,
    model,
    availability,
    provider:
      model === null
        ? findUnavailableProvider(runtime)
        : describeComposerProvider(runtime, model.provider),
    hasProviderOn: runtime.settings.providers.enabled.length > 0
  }
}

/**
 * Calculates whether the model can answer once the backend runs and the
 * composer names a provider.
 *
 * @param readiness - Whether that provider can answer.
 * @param availability - Availability of the model, or null when there is
 * none.
 * @returns `provider-unavailable` while the provider is off, lacks its key,
 * connects, or cannot be reached; once it can answer, `ready` only for a
 * loaded model.
 */
function calculateProviderConnection(
  readiness: ProviderReadiness,
  availability: ModelAvailability | null
): LocalRuntimeConnection {
  switch (readiness) {
    case "backend-offline":
      return "offline"
    case "provider-off":
    case "provider-needs-key":
    case "provider-connecting":
    case "provider-unreachable":
      return "provider-unavailable"
    case "available":
      return findLoadedModelInfo(availability) === undefined
        ? "no-model"
        : "ready"
  }
}

/**
 * Calculates whether the conversation's model can answer, as the composer
 * describes it.
 *
 * @param state - The backend, the model, its availability, and the
 * provider the composer names.
 * @returns The first missing prerequisite, or `ready` only while the model
 * is loaded and its provider can answer; no other model answers in its
 * place. Without a model it is `no-model`, or `provider-unavailable` while
 * no turned-on provider can answer.
 */
export function calculateLocalRuntimeConnection(
  state: ComposerModelState
): LocalRuntimeConnection {
  if (state.backendStatus !== "running") return "offline"
  if (state.provider === null) return "no-model"
  return calculateProviderConnection(
    state.provider.readiness,
    state.availability
  )
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
 * Formats why a provider the composer names cannot answer.
 *
 * @param target - The provider, with its location.
 * @param readiness - Why it cannot answer.
 * @returns That the backend isn't running, or that the provider is off,
 * needs a key, is being connected to, or cannot be reached at its location.
 */
function formatProviderReadinessMessage(
  target: LlmProviderTarget,
  readiness: UnavailableProviderReadiness
): string {
  switch (readiness) {
    case "backend-offline":
      return "The backend isn't running."
    case "provider-off":
      return `${target.name} is turned off.`
    case "provider-needs-key":
      return `${target.name} needs a key.`
    case "provider-connecting":
      return `Connecting to ${target.name}…`
    case "provider-unreachable":
      return `${target.name} can't be reached on ${target.location}.`
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
 * Formats the banner sentence for the model's own state.
 *
 * @param model - The conversation's model.
 * @param availability - Its availability.
 * @param target - Its provider, with its location.
 * @returns Its provider's state while that keeps it from answering; else its
 * state unread, the model not listed, not loaded, or in a load or unload.
 */
function formatModelAvailabilityMessage(
  model: LlmModelReference,
  availability: ModelAvailability,
  target: LlmProviderTarget
): string {
  switch (availability.status) {
    case "provider-off":
    case "provider-connecting":
    case "provider-unreachable":
      return formatProviderReadinessMessage(target, availability.status)
    case "backend-not-running":
    case "inventory-unread":
    case "inventory-failed":
      return "The backend is up, but model state is unavailable."
    case "not-listed":
      return `${model.modelKey} isn't on ${target.name}.`
    case "not-loaded":
      return formatNotLoadedMessage(
        model,
        target.name,
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

/**
 * Formats the banner sentence while the backend runs.
 *
 * @param runtime - The conversation's model, its availability, the provider
 * the composer names, and whether any provider is on.
 * @returns The first missing prerequisite: no provider on; a provider that
 * is off, needs a key, is being connected to, or cannot be reached; no model
 * while a provider can answer; then the model's own state.
 */
function formatRunningRuntimeMessage({
  model,
  availability,
  provider,
  hasProviderOn
}: ComposerModelState): string {
  if (provider === null)
    return hasProviderOn ? NO_MODEL_LOADED_MESSAGE : "No provider is on."
  if (provider.readiness !== "available")
    return formatProviderReadinessMessage(provider.target, provider.readiness)
  if (model === null || availability === null) return NO_MODEL_LOADED_MESSAGE
  return formatModelAvailabilityMessage(model, availability, provider.target)
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

/** The banner action that opens the Models pane to check the models. */
const CHECK_MODELS_ACTION: ComposerBannerAction = Object.freeze({
  kind: "open-settings",
  label: "Check models",
  pane: "model"
})

/**
 * Finds the banner's recovery action for a model that is listed and not
 * loaded.
 *
 * @param model - The conversation's model.
 * @param modelLoading - Who loads its provider's models.
 * @returns Load, which shows the model in the Models pane, when Lys loads
 * the provider's models; otherwise Choose model, because the provider
 * decides what it runs.
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
 * Finds the banner's recovery action for a provider that cannot answer.
 *
 * @param readiness - Why it cannot answer.
 * @returns Open Providers for a provider that is off, needs a key, or
 * cannot be reached; no action while it is being connected to or the
 * backend changes state.
 */
function findProviderReadinessAction(
  readiness: UnavailableProviderReadiness
): ComposerBannerAction {
  switch (readiness) {
    case "provider-off":
    case "provider-needs-key":
    case "provider-unreachable":
      return OPEN_PROVIDERS_ACTION
    case "backend-offline":
    case "provider-connecting":
      return WORKING_ACTION
  }
}

/**
 * Finds the banner's recovery action for the model's own state.
 *
 * @param model - The conversation's model.
 * @param availability - Its availability.
 * @returns Open Providers while its provider is off or not reachable; Check
 * models, which opens the Models pane, while the inventory is unread; Choose
 * model, which opens the model menu, for a model its provider does not list;
 * Load or Choose model for a model that is not loaded; no action while the
 * state already changes.
 */
function findModelAvailabilityAction(
  model: LlmModelReference,
  availability: ModelAvailability
): ComposerBannerAction {
  switch (availability.status) {
    case "provider-off":
    case "provider-unreachable":
      return OPEN_PROVIDERS_ACTION
    case "inventory-unread":
    case "inventory-failed":
      return CHECK_MODELS_ACTION
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
 * Finds the banner's recovery action while the backend runs.
 *
 * @param runtime - The conversation's model, its availability, the provider
 * the composer names, and whether any provider is on.
 * @returns Open Providers while no provider is on; the named provider's
 * action while it cannot answer; Choose model without a model while a
 * provider can answer; then the action for the model's own state.
 */
function findRunningBannerAction({
  model,
  availability,
  provider,
  hasProviderOn
}: ComposerModelState): ComposerBannerAction {
  if (provider === null)
    return hasProviderOn ? CHOOSE_MODEL_ACTION : OPEN_PROVIDERS_ACTION
  if (provider.readiness !== "available")
    return findProviderReadinessAction(provider.readiness)
  if (model === null || availability === null) return CHOOSE_MODEL_ACTION
  return findModelAvailabilityAction(model, availability)
}

/**
 * Finds the banner's recovery action for the current runtime state.
 *
 * @param runtime - The backend, the conversation's model, its availability,
 * the provider the composer names, and whether any provider is on.
 * @returns Start backend for a stopped backend, Check backend, which opens
 * the Runtime pane, for one that does not respond, no action while it starts
 * or stops, and otherwise the action for the first missing prerequisite.
 * Nothing is ever sent to another provider instead.
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
 * Builds one turned-on provider's group of the model menu.
 *
 * @param runtime - Backend state, saved settings, and every provider's
 * state.
 * @param provider - The provider, with its location and whether it can
 * answer.
 * @returns Its models while it can answer and its inventory lists any;
 * otherwise a line saying why it lists none, as the banner would say it.
 */
function buildComposerModelGroup(
  runtime: ComposerRuntime,
  provider: ComposerProviderState
): ComposerModelGroup {
  const { target, readiness } = provider
  if (readiness !== "available") {
    return {
      kind: "status",
      provider: target.provider,
      status: formatProviderReadinessMessage(target, readiness)
    }
  }
  const { inventory, request } = runtime.providerModels[target.provider]
  if (inventory.status !== "ready" || inventory.models.length === 0) {
    return {
      kind: "status",
      provider: target.provider,
      status: formatInventoryMenuStatus(inventory, target.name)
    }
  }
  const choices = inventory.models.map((info) =>
    buildComposerModelChoice(target.provider, info, request)
  )
  return { kind: "models", provider: target.provider, choices }
}

/**
 * Lists the groups of the composer's model menu.
 *
 * @param runtime - Backend state, saved settings, and every provider's
 * state.
 * @returns One group per turned-on provider, in provider order, each as its
 * own inventory arrives; empty while no provider is on.
 */
export function listComposerModelGroups(
  runtime: ComposerRuntime
): readonly ComposerModelGroup[] {
  return listComposerProviders(runtime).map((provider) =>
    buildComposerModelGroup(runtime, provider)
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
 * Formats the placeholder while the conversation's model cannot answer.
 *
 * @param connection - Why the model cannot answer.
 * @param provider - The provider the composer names, or null when there is
 * none.
 * @returns That the composer waits on the backend, on the named provider, or
 * on a model while no provider is named.
 */
function formatWaitingPlaceholder(
  connection: Exclude<LocalRuntimeConnection, "ready">,
  provider: ComposerProviderState | null
): string {
  if (connection === "offline") return "Waiting on the backend…"
  return `Waiting on ${provider?.target.name ?? "a model"}…`
}

/**
 * Formats the composer textarea placeholder.
 *
 * @param state - The backend, the conversation's model, and the provider
 * the composer names.
 * @param activity - Chat work that keeps the composer from sending.
 * @param agent - Agent that answers the next message.
 * @returns The placeholder shown while the field is empty: what the composer
 * waits on, that a conversation whose agent was deleted is read-only, or an
 * invitation naming the agent.
 */
export function formatComposerPlaceholder(
  state: ComposerModelState,
  activity: ComposerActivity,
  agent: ConversationAgent
): string {
  const connection = calculateLocalRuntimeConnection(state)
  if (connection !== "ready")
    return formatWaitingPlaceholder(connection, state.provider)
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
 * Finds the load or unload a model is in, as the composer's label names it.
 *
 * @param availability - Availability of the model.
 * @returns `loading` or `releasing` while Lys loads or unloads the model;
 * null in every other state.
 */
function findModelTransition(
  availability: ModelAvailability
): "loading" | "releasing" | null {
  switch (availability.status) {
    case "loading":
      return "loading"
    case "unloading":
      return "releasing"
    case "backend-not-running":
    case "provider-off":
    case "provider-connecting":
    case "provider-unreachable":
    case "inventory-unread":
    case "inventory-failed":
    case "not-listed":
    case "not-loaded":
    case "loaded":
      return null
  }
}

/**
 * Formats the model label while the backend runs.
 *
 * @param model - The model the next message goes to, or null when there is
 * none.
 * @param availability - Its availability, or null when there is no model.
 * @returns The model with its provider and any load or unload it is in, or
 * that no model is selected.
 */
function formatRunningModelLabel(
  model: LlmModelReference | null,
  availability: ModelAvailability | null
): string {
  if (model === null) return "no model selected"
  const name = formatModelReferenceLabel(model)
  const transition =
    availability === null ? null : findModelTransition(availability)
  return transition === null ? name : `${name} · ${transition}`
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
      return formatRunningModelLabel(model, availability)
  }
}
