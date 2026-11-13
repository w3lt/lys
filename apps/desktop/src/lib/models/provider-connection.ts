import {
  LLM_PROVIDER_NAMES,
  LLM_PROVIDERS,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"
import type { BackendServerStatus } from "@/lib/store"
import type {
  LlmProviderStatus,
  ProviderModelStates
} from "@/lib/store/model-runtime"
import type { ProvidersSettings } from "@/lib/store/settings"
import type { LlmProviderTarget } from "./llm-provider-target"

/**
 * Whether model requests can reach one provider, and why not.
 *
 * @remarks Ordered by prerequisite: the backend must answer before the
 * provider's settings matter, and the provider must be on before its status
 * matters.
 */
export type ProviderAvailability =
  | "backend-offline"
  | "provider-off"
  | "provider-connecting"
  | "provider-unreachable"
  | "available"

/** The application state whether a provider or a model can answer depends on. */
export type ModelAvailabilitySource = {
  /** Backend lifecycle state. */
  readonly backendStatus: BackendServerStatus
  /** Providers the saved settings turn on. */
  readonly enabledProviders: readonly LlmProvider[]
  /** What the desktop knows of every provider. */
  readonly providerModels: ProviderModelStates
}

/** Visual tone of the provider status indicator. */
export type ProviderStatusTone = "active" | "pending" | "idle" | "danger"

/**
 * Formats the explanation shown wherever model features wait for an
 * unreachable provider.
 *
 * @param provider - Provider that cannot be reached.
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
 * Calculates whether model requests can reach one provider, and why not.
 *
 * @param source - Backend state, the providers that are on, and every
 * provider's status.
 * @param provider - Provider to check.
 * @returns `available` only while the backend runs and the provider is on
 * and connected. A provider the saved settings leave off, or that the
 * backend reports `off`, is off. An `unknown` status while the backend runs
 * counts as connecting, because the store reads it right after the backend
 * becomes ready.
 */
export function calculateProviderAvailability(
  source: ModelAvailabilitySource,
  provider: LlmProvider
): ProviderAvailability {
  if (source.backendStatus !== "running") return "backend-offline"
  if (!source.enabledProviders.includes(provider)) return "provider-off"
  switch (source.providerModels[provider].status) {
    case "off":
      return "provider-off"
    case "connected":
      return "available"
    case "unreachable":
      return "provider-unreachable"
    case "unknown":
    case "connecting":
      return "provider-connecting"
  }
}

/**
 * Formats the provider status card heading.
 *
 * @param status - Latest published provider status.
 * @param provider - Provider the card shows.
 * @returns The heading naming the provider and the connection state.
 */
export function formatProviderStatusLabel(
  status: LlmProviderStatus,
  provider: LlmProviderTarget
): string {
  switch (status) {
    case "unknown":
      return `${provider.name} status unknown`
    case "connecting":
      return `Connecting to ${provider.name}`
    case "connected":
      return `${provider.name} connected`
    case "unreachable":
      return `${provider.name} not reachable`
    case "off":
      return `${provider.name} is off`
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
function formatUnknownProviderStatusReason(
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
 * @param status - Latest published provider status.
 * @param backendStatus - Store-owned backend lifecycle state.
 * @param provider - Provider the card shows.
 * @returns The meta line, starting with the provider's location; an
 * `unknown` status adds why it is not known, which depends on the backend's
 * state, an `unreachable` one what to check, and an `off` one where to turn
 * it on.
 */
export function formatProviderStatusMeta(
  status: LlmProviderStatus,
  backendStatus: BackendServerStatus,
  provider: LlmProviderTarget
): string {
  switch (status) {
    case "unknown":
      return `${provider.location} · ${formatUnknownProviderStatusReason(backendStatus)}`
    case "connecting":
      return `${provider.location} · connecting`
    case "connected":
      return provider.location
    case "unreachable":
      return provider.access === "address"
        ? `${provider.location} · start ${provider.name}, then refresh`
        : `${provider.location} · check the key in Providers, then refresh`
    case "off":
      return `${provider.location} · turn it on in Providers`
  }
}

/**
 * Selects the provider status indicator tone.
 *
 * @param status - Latest published provider status.
 * @returns The tone consumed by the status dot's styles.
 */
export function calculateProviderStatusTone(
  status: LlmProviderStatus
): ProviderStatusTone {
  switch (status) {
    case "unknown":
    case "off":
      return "idle"
    case "connecting":
      return "pending"
    case "connected":
      return "active"
    case "unreachable":
      return "danger"
  }
}

/**
 * Lists the providers the saved settings turn on.
 *
 * @param enabledProviders - The saved enabled list, in any order.
 * @returns Those providers in provider order, each once.
 */
export function listEnabledProviders(
  enabledProviders: readonly LlmProvider[]
): LlmProvider[] {
  return LLM_PROVIDERS.filter((provider) => enabledProviders.includes(provider))
}

/**
 * Lists the turned-on providers a refresh connects to again.
 *
 * @param providers - Saved providers, of which the enabled list is read.
 * @param providerModels - What the desktop knows of every provider.
 * @returns Every turned-on provider whose status is not `connecting`, in
 * provider order; an attempt in flight is not asked for again.
 */
export function listRefreshableProviders(
  providers: ProvidersSettings,
  providerModels: ProviderModelStates
): LlmProvider[] {
  return listEnabledProviders(providers.enabled).filter(
    (provider) => providerModels[provider].status !== "connecting"
  )
}

/**
 * Formats the line under the provider connections heading.
 *
 * @param enabledCount - How many providers are on.
 * @returns How many providers are on, or, while none is, where to turn one
 * on.
 */
export function formatProviderConnectionsSummary(enabledCount: number): string {
  if (enabledCount === 0) return "No provider is on · turn one on in Providers"
  return enabledCount === 1 ? "1 provider on" : `${enabledCount} providers on`
}

/**
 * Formats a model's name with its provider's, as every model list shows it.
 *
 * @param model - Model to name.
 * @returns `<key> · <Provider name>`, such as `gpt-oss-20b · LM Studio`, which
 * tells the same key on two providers apart.
 */
export function formatModelReferenceLabel(model: LlmModelReference): string {
  return `${model.modelKey} · ${LLM_PROVIDER_NAMES[model.provider]}`
}
