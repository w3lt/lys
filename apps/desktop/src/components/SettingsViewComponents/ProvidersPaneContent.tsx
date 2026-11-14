import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import { useId, type ReactElement } from "react"

import { useLysStore } from "@/lib/store"

import ProviderCard from "./ProviderCard"

/**
 * Presents the Providers pane: one card per model provider, in provider
 * order, each with a switch that turns it on or off. A card whose provider is
 * on shows where Lys finds it.
 *
 * @remarks The application store owns the saved providers, the keys, their
 * saves, and every provider's connection status. Any number of providers may
 * be on, none included. Saving which providers are on, an address, or a key
 * a turned-on provider uses makes the backend connect to each provider it
 * changed, and that provider's model inventory follows the new connection.
 * Each card shows its own provider's status and saves, and its Test
 * connects to that provider again. The pane accepts no props and is loaded
 * lazily by the settings view.
 * @returns The providers pane body.
 */
export default function ProvidersPane(): ReactElement {
  const headingId = useId()
  const providers = useLysStore((state) => state.settings.providers)
  const secrets = useLysStore((state) => state.settings.secrets)
  const providerModels = useLysStore((state) => state.providerModels)
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const saveState = useLysStore((state) => state.providerSettingsSave)
  const saveProviderSettings = useLysStore(
    (state) => state.saveProviderSettings
  )
  const saveProviderApiKey = useLysStore((state) => state.saveProviderApiKey)
  const connectProvider = useLysStore((state) => state.connectProvider)

  /**
   * Builds one provider's card from the pane's store selections.
   *
   * @param provider - Provider the card presents, which also keys it.
   * @returns The card, whose Test connects to that provider again.
   */
  function buildProviderCard(provider: LlmProvider): ReactElement {
    return (
      <ProviderCard
        backendStatus={backendStatus}
        key={provider}
        onSaveApiKey={saveProviderApiKey}
        onSaveProviders={saveProviderSettings}
        onTest={() => void connectProvider(provider)}
        provider={provider}
        providers={providers}
        saveState={saveState}
        secrets={secrets}
        status={providerModels[provider].status}
      />
    )
  }

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2 id={headingId}>providers</h2>
        <span>{providers.enabled.length} on</span>
      </div>
      <p className="settings-view__note">
        Turn on every provider you use. Each conversation&apos;s model names its
        provider, and nothing goes to a provider that is off.
      </p>
      <div className="settings-view__provider-list">
        {LLM_PROVIDERS.map(buildProviderCard)}
      </div>
    </section>
  )
}
