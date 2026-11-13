import type { LlmInfo, LlmTestModelApiResponse } from "@lys/protocol"
import {
  LLM_PROVIDER_NAMES,
  LLM_PROVIDERS,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"

import type { LlmProviderTarget } from "@/lib/models/llm-provider-target"
import { buildModelLoadConfiguration } from "@/lib/models/model-load-configuration"
import type { ProviderAvailability } from "@/lib/models/provider-connection"
import type {
  ModelInventoryState,
  ModelRequestState
} from "@/lib/store/model-runtime"
import type {
  LoadConfigurationSettings,
  SecretsSettings
} from "@/lib/store/settings"

import { findSavedProviderApiKey } from "./provider-presentation"

/** Where a provider runs its models. */
export type ModelPlacement = "local" | "cloud"

/** Tone of a status dot in the Model pane, named after its style. */
export type ModelPaneTone = "active" | "pending" | "idle" | "danger"

/** What the Model pane needs to know of one provider's character. */
export type ModelPaneProviderProfile = {
  /** Where the provider runs its models. */
  readonly placement: ModelPlacement
  /** Where the provider's models run, as the details name it. */
  readonly runsOn: string
  /** What the provider does with its models, shown in its card. */
  readonly note: string
}

/** Where the Model pane's choice of provider and model comes from. */
export type ModelPaneChoiceSource = {
  /** Providers that are on, in any order. */
  readonly enabledProviders: readonly LlmProvider[]
  /** Model the pane was asked to show, or null. */
  readonly selection: LlmModelReference | null
  /** Provider the pane's picker chose, or null. */
  readonly chosenProvider: LlmProvider | null
  /** Default model for this session, or null. */
  readonly defaultModel: LlmModelReference | null
}

/** One fact about the selected model, shown under its status. */
export type ModelFact = {
  /** Name of the fact. */
  readonly label: string
  /** Its value as the pane shows it. */
  readonly value: string
}

/** A model key cut into the parts its row styles apart. */
export type ModelKeyParts = {
  /** Namespace up to and including the last slash, or empty. */
  readonly prefix: string
  /** Name between the namespace and the tag. */
  readonly base: string
  /** Tag from its colon on, or empty. */
  readonly tag: string
}

/** Providers that are on and run their models in one place. */
export type ModelProviderGroup = {
  /** Where the group's providers run models. */
  readonly placement: ModelPlacement
  /** Summaries of the group's providers, in provider order. */
  readonly summaries: readonly ModelProviderSummary[]
}

/** What the Model pane's provider card and picker say of one provider. */
export type ModelProviderSummary = {
  /** The provider. */
  readonly provider: LlmProvider
  /** Provider's name. */
  readonly name: string
  /** Where the provider runs models. */
  readonly placement: ModelPlacement
  /** Tone of its status dot. */
  readonly tone: ModelPaneTone
  /** Its status in a word or two. */
  readonly status: string
  /** How many models it has, or null before its inventory is read. */
  readonly count: string | null
  /** Where Lys reaches it. */
  readonly location: string
  /** Key of the session's default model when it is this provider's, or null. */
  readonly defaultModelKey: string | null
}

/**
 * What the footer of the selected model's details offers: it is the
 * default already, it can be made the default, it must be loaded first, or
 * it is being loaded.
 */
export type ModelDefaultChoice = "current" | "set" | "load-and-set" | "loading"

/** What the status box of the selected model says. */
export type ModelStatusDescription = {
  /** Tone of the status dot. */
  readonly tone: ModelPaneTone
  /** The state in one or two words. */
  readonly word: string
  /** Where the model is, or what is happening to it. */
  readonly place: string
  /** What the state means for the person, or what they can do. */
  readonly note: string
}

/** What the Model pane shows in place of the model list, and its way out. */
export type ModelPaneEmptyState = {
  /** The situation in one sentence. */
  readonly title: string
  /** What to do about it; may be empty. */
  readonly body: string
  /** Pane that resolves it, or null when nothing there does. */
  readonly settingsPane: "providers" | "runtime" | null
}

/** The selected model's status inputs that a check of it can change. */
export type ModelCheckObservation = {
  /** The provider's request in flight, or idle. */
  readonly request: ModelRequestState
  /** The provider's latest health observation, or null. */
  readonly health: LlmTestModelApiResponse | null
  /** The provider's latest request failure, or null. */
  readonly error: string | null
  /** When the provider's latest operation settled, or null. */
  readonly settledAt: Date | null
  /** Whether a check of this model was asked for while it is shown. */
  readonly isCheckRequested: boolean
}

/** Words that differ between the providers whose models are checked. */
type CheckedModelWording = {
  /** Provider asked by the check. */
  readonly providerName: string
  /** The state the model was last known in, in one or two words. */
  readonly knownWord: string
  /** Where the model is in that state. */
  readonly knownPlace: string
  /** What a check asks. */
  readonly caption: string
  /** Sentence after the check time when the model answered as known. */
  readonly confirmed: string
}

/** Bytes in one decimal gigabyte, the unit model sizes are shown in. */
const BYTES_PER_GIGABYTE = 1_000_000_000

/** Shown for a fact the provider does not report. */
const NOT_REPORTED = "Not reported"

/** Tag Ollama applies to a model key that names none. */
const DEFAULT_MODEL_TAG = "latest"

/**
 * Describes a provider's character for the Model pane.
 *
 * @param provider - Provider to describe.
 * @returns Where it runs models, and its card note.
 */
export function describeModelPaneProvider(
  provider: LlmProvider
): ModelPaneProviderProfile {
  switch (provider) {
    case "lmStudio":
      return {
        placement: "local",
        runsOn: "This machine",
        note: "Models run in LM Studio on this machine. Only loaded models can answer, and each one uses memory while it is loaded."
      }
    case "ollama":
      return {
        placement: "local",
        runsOn: "This machine",
        note: "Models run on this machine. Only loaded models can answer, and each one uses memory while it is loaded."
      }
    case "ollamaCloud":
      return {
        placement: "cloud",
        runsOn: "Ollama Cloud",
        note: "Ollama Cloud decides what stays in memory. A model it isn’t running answers once you start it there."
      }
    case "groq":
      return {
        placement: "cloud",
        runsOn: "Groq",
        note: "Groq hosts every model and runs it when Lys sends a message. There is nothing to load."
      }
  }
}

/**
 * Finds the provider the Model pane shows.
 *
 * @param source - Providers that are on, and the pane's and the session's
 * choices.
 * @returns The selected model's provider, else the picker's provider, else
 * the default model's provider, else the first provider that is on, in
 * provider order; each only while it is on. Null when no provider is on.
 */
export function findModelPaneProvider(
  source: ModelPaneChoiceSource
): LlmProvider | null {
  const candidates = [
    source.selection?.provider,
    source.chosenProvider ?? undefined,
    source.defaultModel?.provider,
    ...LLM_PROVIDERS
  ]
  return (
    candidates.find(
      (provider) =>
        provider !== undefined && source.enabledProviders.includes(provider)
    ) ?? null
  )
}

/**
 * Finds the key of the model the Model pane shows for one provider.
 *
 * @param provider - Provider the pane shows.
 * @param source - The pane's and the session's choices.
 * @param models - Models the provider's inventory lists.
 * @returns The selected model's key, else the default model's key, when it
 * is the provider's and listed; else null.
 */
export function findModelPaneModelKey(
  provider: LlmProvider,
  source: ModelPaneChoiceSource,
  models: readonly LlmInfo[]
): string | null {
  const candidates = [source.selection, source.defaultModel]
  const reference = candidates.find(
    (candidate) =>
      candidate?.provider === provider &&
      models.some((model) => model.modelKey === candidate.modelKey)
  )
  return reference?.modelKey ?? null
}

/**
 * Groups the providers that are on as the picker shows them.
 *
 * @param summaries - Summaries of the providers that are on, in provider
 * order.
 * @returns Cloud providers, then providers on this machine, each in the
 * given order; a group without a provider is left out.
 */
export function listModelProviderGroups(
  summaries: readonly ModelProviderSummary[]
): readonly ModelProviderGroup[] {
  const placements: readonly ModelPlacement[] = ["cloud", "local"]
  return placements
    .map((placement) => ({
      placement,
      summaries: summaries.filter((summary) => summary.placement === placement)
    }))
    .filter((group) => group.summaries.length > 0)
}

/**
 * Formats the name of a group of providers in the picker.
 *
 * @param placement - Where the group's providers run models.
 * @returns The group's heading.
 */
export function formatModelPlacementName(placement: ModelPlacement): string {
  return placement === "cloud" ? "Cloud" : "On this machine"
}

/**
 * Selects the tone of a provider's status dot.
 *
 * @param availability - Whether model requests reach the provider.
 * @returns Active when they do, pending while it connects, danger while it
 * cannot be reached, idle otherwise.
 */
export function calculateModelProviderTone(
  availability: ProviderAvailability
): ModelPaneTone {
  switch (availability) {
    case "available":
      return "active"
    case "provider-connecting":
      return "pending"
    case "provider-unreachable":
      return "danger"
    case "backend-offline":
    case "provider-off":
      return "idle"
  }
}

/**
 * Formats a provider's status in a word or two.
 *
 * @param availability - Whether model requests reach the provider.
 * @param placement - Where the provider runs models.
 * @returns Running or Not running for a provider on this machine,
 * Connected or Can't be reached for a cloud provider, and the backend's or
 * the connection's state otherwise.
 */
export function formatModelProviderStatus(
  availability: ProviderAvailability,
  placement: ModelPlacement
): string {
  switch (availability) {
    case "available":
      return placement === "local" ? "Running" : "Connected"
    case "provider-unreachable":
      return placement === "local" ? "Not running" : "Can’t be reached"
    case "provider-connecting":
      return "Connecting…"
    case "provider-off":
      return "Off"
    case "backend-offline":
      return "Backend not running"
  }
}

/**
 * Formats how many models a provider has, as its card counts them.
 *
 * @param inventory - The provider's latest inventory observation.
 * @param placement - Where the provider runs models.
 * @returns How many of the listed models are loaded on this machine, or
 * how many models a cloud provider lists; null until an inventory is read.
 */
export function formatModelCount(
  inventory: ModelInventoryState,
  placement: ModelPlacement
): string | null {
  if (inventory.status !== "ready") return null
  const total = inventory.models.length
  if (placement === "local") {
    const loaded = inventory.models.filter((model) => model.loaded).length
    return `${loaded} of ${total} loaded`
  }
  return total === 1 ? "1 model" : `${total} models`
}

/**
 * Builds what the provider card and picker say of one provider.
 *
 * @param target - The provider and where Lys reaches it.
 * @param availability - Whether model requests reach the provider.
 * @param inventory - The provider's latest inventory observation.
 * @param defaultModel - The session's default model, or null.
 * @returns The provider's name, placement, status, count, location, and
 * the key of the default model when it is this provider's.
 */
export function buildModelProviderSummary(
  target: LlmProviderTarget,
  availability: ProviderAvailability,
  inventory: ModelInventoryState,
  defaultModel: LlmModelReference | null
): ModelProviderSummary {
  const { placement } = describeModelPaneProvider(target.provider)
  return {
    provider: target.provider,
    name: target.name,
    placement,
    tone: calculateModelProviderTone(availability),
    status: formatModelProviderStatus(availability, placement),
    count: formatModelCount(inventory, placement),
    location: target.location,
    defaultModelKey:
      defaultModel?.provider === target.provider ? defaultModel.modelKey : null
  }
}

/**
 * Formats a time as hours and minutes on a 24-hour clock.
 *
 * @param time - Time to format, read in the local time zone.
 * @returns The time as `HH:MM`.
 */
export function formatClockTime(time: Date): string {
  const hours = String(time.getHours()).padStart(2, "0")
  const minutes = String(time.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

/**
 * Formats the line beside a provider's Refresh button.
 *
 * @param request - The provider's request in flight, or idle.
 * @param settledAt - When its latest operation settled, or null.
 * @param providerName - Provider's name.
 * @returns What a refresh in flight is doing, else when the provider was
 * last read, else nothing.
 */
export function formatModelRefreshNote(
  request: ModelRequestState,
  settledAt: Date | null,
  providerName: string
): string {
  if (request.status === "listing") return `Asking ${providerName}…`
  if (settledAt === null) return ""
  return `Refreshed at ${formatClockTime(settledAt)}`
}

/**
 * Cuts a model key into the parts its row styles apart.
 *
 * @param modelKey - Key to cut.
 * @returns The namespace before the last slash, the tag from the first
 * colon after it, and the name between; empty parts are empty strings.
 */
export function splitModelKey(modelKey: string): ModelKeyParts {
  const nameStart = modelKey.lastIndexOf("/") + 1
  const tagStart = modelKey.indexOf(":", nameStart)
  const nameEnd = tagStart === -1 ? modelKey.length : tagStart
  return {
    prefix: modelKey.slice(0, nameStart),
    base: modelKey.slice(nameStart, nameEnd),
    tag: modelKey.slice(nameEnd)
  }
}

/**
 * Lists the models whose key or display name contains a filter.
 *
 * @param models - Models to filter.
 * @param query - Text typed into the filter; surrounding spaces and case are
 * ignored.
 * @returns The matching models in their order; all of them for an empty
 * filter.
 */
export function listMatchingModels(
  models: readonly LlmInfo[],
  query: string
): readonly LlmInfo[] {
  const needle = query.trim().toLowerCase()
  if (needle === "") return models
  return models.filter((model) =>
    `${model.modelKey}\n${model.displayName}`.toLowerCase().includes(needle)
  )
}

/**
 * Formats the heading of the model list.
 *
 * @param shownCount - Models the filter leaves.
 * @param totalCount - Models the inventory lists.
 * @returns How many models there are, or how many of them the filter shows.
 */
export function formatModelListHeading(
  shownCount: number,
  totalCount: number
): string {
  return shownCount === totalCount
    ? `All models · ${totalCount}`
    : `Showing ${shownCount} of ${totalCount}`
}

/**
 * Formats a model's size on disk.
 *
 * @param sizeBytes - Size the provider reports, or undefined.
 * @returns Decimal gigabytes with one decimal, or that it is not reported.
 */
export function formatModelSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return NOT_REPORTED
  return `${(sizeBytes / BYTES_PER_GIGABYTE).toFixed(1)} GB`
}

/**
 * Formats a context length as an exact count of tokens.
 *
 * @param tokens - Context length in tokens.
 * @returns The count with thousands separators, then `tokens`.
 */
export function formatContextTokens(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`
}

/**
 * Lists the facts shown under the selected model's status.
 *
 * @param provider - Provider of the model.
 * @param model - The selected model.
 * @returns Size, format or tag, and where it runs; for Groq, which reports
 * no size, its context length and that nothing is loaded instead.
 */
export function listModelFacts(
  provider: LlmProvider,
  model: LlmInfo
): readonly ModelFact[] {
  const runsOn = {
    label: "Runs on",
    value: describeModelPaneProvider(provider).runsOn
  }
  const size = { label: "Size", value: formatModelSize(model.sizeBytes) }
  switch (provider) {
    case "lmStudio":
      return [
        size,
        { label: "Format", value: formatModelFormat(model) },
        runsOn
      ]
    case "ollama":
    case "ollamaCloud":
      return [size, { label: "Tag", value: formatModelTag(model) }, runsOn]
    case "groq":
      return [
        {
          label: "Context",
          value: formatContextTokens(model.maxContextLength)
        },
        { label: "Loading", value: "Not needed" },
        runsOn
      ]
  }
}

/**
 * Formats a model's weight format.
 *
 * @param model - Model whose format is shown.
 * @returns The format in capitals, or that it is not reported.
 */
function formatModelFormat(model: LlmInfo): string {
  return model.format?.toUpperCase() ?? NOT_REPORTED
}

/**
 * Formats a model's tag.
 *
 * @param model - Model whose tag is shown.
 * @returns The tag after the colon, or the tag Ollama applies to a key that
 * names none.
 */
function formatModelTag(model: LlmInfo): string {
  const { tag } = splitModelKey(model.modelKey)
  return tag === "" ? DEFAULT_MODEL_TAG : tag.slice(1)
}

/**
 * Describes the status of a model on this machine.
 *
 * @param provider - LM Studio or Ollama.
 * @param model - The selected model.
 * @param request - The provider's request in flight, or idle.
 * @param isDefault - Whether the model is the session's default.
 * @returns Loading or unloading while that request runs for the model,
 * else loaded or not loaded, with what the person can do.
 */
export function describeLocalModelStatus(
  provider: "lmStudio" | "ollama",
  model: LlmInfo,
  request: ModelRequestState,
  isDefault: boolean
): ModelStatusDescription {
  const transition = findModelTransition(request, model.modelKey)
  if (transition !== null) return describeModelTransition(transition)
  if (!model.loaded) {
    return {
      tone: "idle",
      word: "Not loaded",
      place: "On disk",
      note:
        provider === "lmStudio"
          ? "Load it to use it. Loading takes a moment and uses memory on this machine."
          : "Start it in Ollama to use it. Lys can’t load Ollama models yet."
    }
  }
  return {
    tone: "active",
    word: "Loaded",
    place: "In this machine’s memory",
    note: formatLoadedModelNote(provider, isDefault)
  }
}

/**
 * Formats the note of a model loaded on this machine.
 *
 * @param provider - LM Studio or Ollama.
 * @param isDefault - Whether the model is the session's default.
 * @returns Why Unload is not offered, or what unloading does.
 */
function formatLoadedModelNote(
  provider: "lmStudio" | "ollama",
  isDefault: boolean
): string {
  if (provider === "ollama") {
    return "Ollama unloads it when it sits idle. Lys can’t unload Ollama models yet."
  }
  return isDefault
    ? "It’s the default for this session. Choose another default before unloading it."
    : "Unloading frees its memory. It can’t answer until you load it again."
}

/**
 * Finds whether a request is loading or unloading one model.
 *
 * @param request - The provider's request in flight, or idle.
 * @param modelKey - Key of the model.
 * @returns `loading` or `unloading` while that request is for the model,
 * else null.
 */
export function findModelTransition(
  request: ModelRequestState,
  modelKey: string
): "loading" | "unloading" | null {
  if (request.status !== "loading" && request.status !== "unloading") {
    return null
  }
  return request.modelKey === modelKey ? request.status : null
}

/**
 * Describes a model being loaded or unloaded on this machine.
 *
 * @param transition - What is happening to the model.
 * @returns The pending status.
 */
function describeModelTransition(
  transition: "loading" | "unloading"
): ModelStatusDescription {
  return transition === "loading"
    ? {
        tone: "pending",
        word: "Loading…",
        place: "Into this machine’s memory",
        note: "It can answer as soon as it finishes."
      }
    : {
        tone: "pending",
        word: "Unloading…",
        place: "Out of this machine’s memory",
        note: "It can’t answer once it finishes."
      }
}

/**
 * Describes the status of a model a cloud provider runs.
 *
 * @param provider - Ollama Cloud or Groq.
 * @param model - The selected model.
 * @param observation - The provider's request, health, failure, and
 * settlement time, and whether this model's check was asked for.
 * @returns Checking while its check runs; a failed check with the last
 * known state; the checked state with its time; else the listed state and
 * what Check status does.
 */
export function describeCloudModelStatus(
  provider: "ollamaCloud" | "groq",
  model: LlmInfo,
  observation: ModelCheckObservation
): ModelStatusDescription {
  const wording = buildCheckedModelWording(provider, model)
  const { request, settledAt } = observation
  if (request.status === "testing" && request.modelKey === model.modelKey) {
    return {
      tone: "pending",
      word: "Checking…",
      place: `Asking ${wording.providerName}…`,
      note: wording.caption
    }
  }
  if (isModelCheckFailed(observation, model.modelKey)) {
    return {
      tone: "danger",
      word: "Couldn’t check",
      place: "",
      note: `${wording.providerName} didn’t answer. The last known state was ${wording.knownWord.toLowerCase()}.`
    }
  }
  const health = findModelHealth(observation.health, model.modelKey)
  if (health === null || settledAt === null) {
    return { ...describeKnownModelStatus(wording), note: wording.caption }
  }
  return describeCheckedModelStatus(wording, health, settledAt)
}

/**
 * Builds the words a cloud provider's model status uses.
 *
 * @param provider - Ollama Cloud or Groq.
 * @param model - The selected model.
 * @returns For Ollama Cloud, loaded or not loaded as its inventory says; for
 * Groq, which hosts every model, available.
 */
function buildCheckedModelWording(
  provider: "ollamaCloud" | "groq",
  model: LlmInfo
): CheckedModelWording {
  if (provider === "groq") {
    return {
      providerName: LLM_PROVIDER_NAMES.groq,
      knownWord: "Available",
      knownPlace: "Hosted by Groq",
      caption:
        "Check status asks Groq whether your key can use this model. It does not generate a reply.",
      confirmed: "Available."
    }
  }
  return {
    providerName: LLM_PROVIDER_NAMES.ollamaCloud,
    knownWord: model.loaded ? "Loaded" : "Not loaded",
    knownPlace: model.loaded
      ? "In memory on Ollama Cloud"
      : "Not in memory on Ollama Cloud",
    caption:
      "Check status asks Ollama Cloud whether this model is in memory. It does not generate a reply.",
    confirmed: model.loaded ? "Still loaded." : "Still not loaded."
  }
}

/**
 * Describes the state a cloud model was last known in.
 *
 * @param wording - The provider's words.
 * @returns Active while it was known loaded or available, idle otherwise;
 * the note is left to the caller.
 */
function describeKnownModelStatus(
  wording: CheckedModelWording
): Omit<ModelStatusDescription, "note"> {
  return {
    tone: wording.knownWord === "Not loaded" ? "idle" : "active",
    word: wording.knownWord,
    place: wording.knownPlace
  }
}

/**
 * Describes a cloud model after its check answered.
 *
 * @param wording - The provider's words.
 * @param health - The check's observation of this model.
 * @param settledAt - When the check settled.
 * @returns The confirmed state, or not loaded when the provider reports the
 * model is not in memory, with the check time.
 */
function describeCheckedModelStatus(
  wording: CheckedModelWording,
  health: LlmTestModelApiResponse,
  settledAt: Date
): ModelStatusDescription {
  const checkedAt = `Checked at ${formatClockTime(settledAt)}.`
  if (health.status === "ready") {
    return {
      ...describeKnownModelStatus(wording),
      tone: "active",
      note: `${checkedAt} ${wording.confirmed}`
    }
  }
  return {
    tone: "idle",
    word: "Not loaded",
    place: `Not in memory on ${wording.providerName}`,
    note: `${checkedAt} ${wording.providerName} isn’t running it now.`
  }
}

/**
 * Finds the health observation of one model.
 *
 * @param health - The provider's latest health observation, or null.
 * @param modelKey - Key of the model.
 * @returns The observation while it is of that model and the runtime
 * answered it; null otherwise.
 */
function findModelHealth(
  health: LlmTestModelApiResponse | null,
  modelKey: string
): LlmTestModelApiResponse | null {
  if (health?.modelId !== modelKey) return null
  return health.status === "not-ready" &&
    health.reason === "runtime-unavailable"
    ? null
    : health
}

/**
 * Answers whether the check the person asked for of one model failed.
 *
 * @param observation - The provider's request, health, and failure, and
 * whether this model's check was asked for.
 * @param modelKey - Key of the model.
 * @returns True after an asked-for check settled with a failure, or with
 * the runtime reported unavailable, and before another request starts.
 */
export function isModelCheckFailed(
  observation: ModelCheckObservation,
  modelKey: string
): boolean {
  const { request, health, error } = observation
  if (!observation.isCheckRequested || request.status !== "idle") return false
  if (health === null) return error !== null
  return (
    health.modelId === modelKey &&
    health.status === "not-ready" &&
    health.reason === "runtime-unavailable"
  )
}

/**
 * Describes what the Model pane shows when a provider cannot list models.
 *
 * @param availability - Whether model requests reach the provider.
 * @param target - The provider and where it is reached.
 * @param isKeyMissing - Whether the provider needs a key and none is saved.
 * @returns Why no models are listed and where to fix it, or null while the
 * provider can be asked for its models.
 */
export function describeProviderEmptyState(
  availability: ProviderAvailability,
  target: LlmProviderTarget,
  isKeyMissing: boolean
): ModelPaneEmptyState | null {
  if (availability === "backend-offline") {
    return {
      title: "The backend isn’t running.",
      body: "Start it in Runtime to list models.",
      settingsPane: "runtime"
    }
  }
  if (isKeyMissing) {
    return {
      title: `${target.name} needs a key.`,
      body: `Add your ${target.name} key in Providers to list its models.`,
      settingsPane: "providers"
    }
  }
  switch (availability) {
    case "available":
      return null
    case "provider-connecting":
      return {
        title: `Connecting to ${target.name}…`,
        body: "",
        settingsPane: null
      }
    case "provider-off":
      return {
        title: `${target.name} is off.`,
        body: "Turn it on in Providers to list its models.",
        settingsPane: "providers"
      }
    case "provider-unreachable":
      return describeUnreachableProvider(target)
  }
}

/**
 * Describes a provider that cannot be reached.
 *
 * @param target - The provider and where it is reached.
 * @returns For a provider at an address, that it is not running and where
 * it should answer; for a provider with a key, what to check.
 */
function describeUnreachableProvider(
  target: LlmProviderTarget
): ModelPaneEmptyState {
  if (target.access === "address") {
    return {
      title: `${target.name} isn’t running on this machine.`,
      body: `Start its local server, then refresh. Its models show here once it answers at ${target.location}.`,
      settingsPane: null
    }
  }
  return {
    title: `${target.name} can’t be reached.`,
    body: "Check its key in Providers and your network, then refresh.",
    settingsPane: "providers"
  }
}

/**
 * Describes what the Model pane shows when a reachable provider's
 * inventory lists no model.
 *
 * @param inventory - The provider's latest inventory observation.
 * @param request - The provider's request in flight, or idle.
 * @param target - The provider and where it is reached.
 * @returns Why the list is empty, or null when it lists models.
 */
export function describeInventoryEmptyState(
  inventory: ModelInventoryState,
  request: ModelRequestState,
  target: LlmProviderTarget
): ModelPaneEmptyState | null {
  if (inventory.status === "ready" && inventory.models.length > 0) return null
  if (request.status === "listing") {
    return {
      title: `Reading models from ${target.name}…`,
      body: "",
      settingsPane: null
    }
  }
  switch (inventory.status) {
    case "failed":
      return {
        title: `Couldn’t list ${target.name}’s models.`,
        body: "Refresh to try again.",
        settingsPane: null
      }
    case "unavailable":
      return { title: "Refresh to list models.", body: "", settingsPane: null }
    case "ready":
      return {
        title: `${target.name} lists no models.`,
        body:
          target.access === "address"
            ? `Download a model in ${target.name}, then refresh.`
            : "No model is offered to your key.",
        settingsPane: null
      }
  }
}

/**
 * Answers whether a provider that needs a key has none saved.
 *
 * @param provider - Provider to check.
 * @param secrets - Saved secrets.
 * @returns True for Ollama Cloud or Groq without a saved key; false for a
 * provider on this machine, which needs none.
 */
export function isModelProviderKeyMissing(
  provider: LlmProvider,
  secrets: SecretsSettings
): boolean {
  switch (provider) {
    case "lmStudio":
    case "ollama":
      return false
    case "ollamaCloud":
    case "groq":
      return findSavedProviderApiKey(provider, secrets) === null
  }
}

/**
 * Calculates the context length a model is shown with.
 *
 * @param provider - Provider of the model.
 * @param model - The model.
 * @param loadConfiguration - Stored load settings, which name LM Studio's
 * models.
 * @returns The length the model is loaded with when the provider reports
 * it; else, for LM Studio, the length its stored settings load it with, and
 * for any other provider the model's maximum.
 */
export function calculateModelContextLength(
  provider: LlmProvider,
  model: LlmInfo,
  loadConfiguration: LoadConfigurationSettings
): number {
  if (model.loadedContextLength !== undefined) return model.loadedContextLength
  return provider === "lmStudio"
    ? buildModelLoadConfiguration(loadConfiguration, model).contextLength
    : model.maxContextLength
}

/**
 * Finds a model an inventory lists.
 *
 * @param inventory - A provider's latest inventory observation.
 * @param modelKey - Key of the model.
 * @returns The listed model, or undefined when the inventory is not read or
 * does not list it.
 */
export function findListedModel(
  inventory: ModelInventoryState,
  modelKey: string
): LlmInfo | undefined {
  return inventory.status === "ready"
    ? inventory.models.find((model) => model.modelKey === modelKey)
    : undefined
}

/**
 * Finds what the selected model's footer offers.
 *
 * @param provider - Provider of the model.
 * @param model - The selected model.
 * @param isDefault - Whether it is the session's default.
 * @param request - The provider's request in flight, or idle.
 * @returns That it is the default; else that it is being loaded; else, for
 * an LM Studio model that is not loaded, that it must be loaded first; else
 * that it can be made the default.
 */
export function findModelDefaultChoice(
  provider: LlmProvider,
  model: LlmInfo,
  isDefault: boolean,
  request: ModelRequestState
): ModelDefaultChoice {
  if (isDefault) return "current"
  if (findModelTransition(request, model.modelKey) === "loading") {
    return "loading"
  }
  return provider === "lmStudio" && !model.loaded ? "load-and-set" : "set"
}
