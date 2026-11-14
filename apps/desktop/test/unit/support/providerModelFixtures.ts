import type { LlmRuntimeConnectionStatus } from "@lys/protocol"
import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import type { ComposerRuntime } from "@/components/ComposerComponents/composer-presentation"
import type { ModelAvailabilitySource } from "@/lib/models/provider-connection"
import type { BackendServerStatus } from "@/lib/store"
import type { SecretsSettings } from "@/lib/store/settings"
import {
  INITIAL_PROVIDER_MODEL_STATES,
  updateProviderModelState,
  type ProviderModelState,
  type ProviderModelStates
} from "@/lib/store/model-runtime"
import {
  buildJsonResponse,
  type BackendRoute,
  type BackendRoutes
} from "./backendFake"
import { STORED_PROVIDERS_SETTINGS, STORED_SETTINGS } from "./settingsFixtures"

/** What a case arranges of the providers; every omitted fact keeps its default. */
export type ProviderModelArrangement = Readonly<{
  /** Backend lifecycle state; running by default. */
  backendStatus?: BackendServerStatus
  /**
   * Providers the saved settings turn on; by default, every provider the
   * case arranges a state for.
   */
  enabledProviders?: readonly LlmProvider[]
  /** Fields of each provider's state the case sets; the rest are initial. */
  providers?: Readonly<
    Partial<Record<LlmProvider, Partial<ProviderModelState>>>
  >
}>

/**
 * Builds every provider's state from the initial one.
 *
 * @param providers - Fields of each provider's state the case sets.
 * @returns The states, each initial except for the fields set.
 */
export function buildProviderModelStates(
  providers: ProviderModelArrangement["providers"] = {}
): ProviderModelStates {
  let states = INITIAL_PROVIDER_MODEL_STATES
  for (const [provider, change] of Object.entries(providers) as [
    LlmProvider,
    Partial<ProviderModelState>
  ][]) {
    states = updateProviderModelState(states, provider, change)
  }
  return states
}

/**
 * Builds the application state whether a model can answer depends on.
 *
 * @param arrangement - Backend state, the providers that are on, and each
 * provider's state.
 * @returns A frozen source.
 */
export function buildModelAvailabilitySource(
  arrangement: ProviderModelArrangement = {}
): ModelAvailabilitySource {
  const providers = arrangement.providers ?? {}
  return Object.freeze({
    backendStatus: arrangement.backendStatus ?? "running",
    enabledProviders:
      arrangement.enabledProviders ??
      Object.freeze(Object.keys(providers) as LlmProvider[]),
    providerModels: buildProviderModelStates(providers)
  })
}

/**
 * Builds the application state the composer's banner and model menu read.
 *
 * @param arrangement - Backend state, the providers that are on, and each
 * provider's state.
 * @param secrets - Saved keys; when omitted, the stored ones, which hold a
 * Groq key and no Ollama key.
 * @returns A frozen runtime whose saved providers keep the stored addresses
 * (LM Studio at its default, local Ollama at 192.168.1.20:11434) with the
 * arranged providers on.
 */
export function buildComposerRuntime(
  arrangement: ProviderModelArrangement = {},
  secrets: SecretsSettings = STORED_SETTINGS.secrets
): ComposerRuntime {
  const source = buildModelAvailabilitySource(arrangement)
  return Object.freeze({
    backendStatus: source.backendStatus,
    settings: Object.freeze({
      providers: Object.freeze({
        ...STORED_PROVIDERS_SETTINGS,
        enabled: source.enabledProviders
      }),
      secrets
    }),
    providerModels: source.providerModels
  })
}

/**
 * Builds the backend's status routes of every provider.
 *
 * @param statuses - Status each provider's route reports; `off` for every
 * provider left out, as the backend reports a provider the settings leave
 * off.
 * @returns One status route per provider, each answering at once.
 */
export function buildProviderStatusRoutes(
  statuses: Readonly<
    Partial<Record<LlmProvider, LlmRuntimeConnectionStatus>>
  > = {}
): BackendRoutes {
  return Object.freeze(
    Object.fromEntries(
      LLM_PROVIDERS.map((provider): [string, BackendRoute] => [
        `GET /api/v1/llm/${provider}/runtime`,
        () => buildJsonResponse(200, { status: statuses[provider] ?? "off" })
      ])
    )
  )
}
