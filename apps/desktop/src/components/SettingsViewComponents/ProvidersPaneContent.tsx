import { useId, type ReactElement } from "react"

import { useLysStore } from "@/lib/store"

import ProviderCard from "./ProviderCard"
import {
  findProviderCardProvider,
  PROVIDER_CARD_ORDER
} from "./provider-presentation"

/**
 * Presents the Providers pane: one card per model provider, Ollama's card
 * covering both a local server and Ollama Cloud. A card whose provider is on
 * shows where Lys finds it.
 *
 * @remarks The application store owns the saved providers, the keys, their
 * saves, and every provider's connection status. Picking a card turns its
 * provider on alone. Saving which providers are on, an address, or a key a
 * turned-on provider uses makes the backend connect to each provider it
 * changed, and that provider's model inventory follows the new connection.
 * Each card shows its own provider's status, and its Test connects to that
 * provider again. The pane accepts no props and is loaded lazily by the
 * settings view.
 * @returns The providers pane body.
 */
export default function ProvidersPane(): ReactElement {
  const headingId = useId()
  const radioName = useId()
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

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2 id={headingId}>provider</h2>
        <span>{PROVIDER_CARD_ORDER.length} providers</span>
      </div>
      <p className="settings-view__note">
        Every request goes to one provider. Pick it here and tell Lys where to
        find it.
      </p>
      <div
        aria-labelledby={headingId}
        className="settings-view__provider-list"
        role="radiogroup"
      >
        {PROVIDER_CARD_ORDER.map((card) => {
          const provider = findProviderCardProvider(card, providers)
          return (
            <ProviderCard
              backendStatus={backendStatus}
              card={card}
              key={card}
              onSaveApiKey={saveProviderApiKey}
              onSaveProviders={saveProviderSettings}
              onTest={() => void connectProvider(provider)}
              providers={providers}
              radioName={radioName}
              saveState={saveState}
              secrets={secrets}
              status={providerModels[provider].status}
            />
          )
        })}
      </div>
    </section>
  )
}
