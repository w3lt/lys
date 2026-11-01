import { useId, type ReactElement } from "react"

import { useLysStore } from "@/lib/store"

import ProviderCard from "./ProviderCard"
import { PROVIDER_CARD_ORDER } from "./provider-presentation"

/**
 * Presents the Providers pane: one card per model provider, Ollama's card
 * covering both a local server and Ollama Cloud. The card of the active
 * provider shows where Lys finds it.
 *
 * @remarks The application store owns the saved provider choice, the keys,
 * their saves, and the connection status. Saving a choice, an address, or a
 * key the active provider uses makes the backend connect again, and the
 * model inventory follows the new connection. Test connects to the active
 * provider again. The pane accepts no props and is loaded lazily by the
 * settings view.
 * @returns The providers pane body.
 */
export default function ProvidersPane(): ReactElement {
  const headingId = useId()
  const radioName = useId()
  const providers = useLysStore((state) => state.settings.providers)
  const secrets = useLysStore((state) => state.settings.secrets)
  const status = useLysStore((state) => state.lmStudioStatus)
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const saveState = useLysStore((state) => state.providerSettingsSave)
  const saveProviderSettings = useLysStore(
    (state) => state.saveProviderSettings
  )
  const saveProviderApiKey = useLysStore((state) => state.saveProviderApiKey)
  const connectLmStudio = useLysStore((state) => state.connectLmStudio)

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
        {PROVIDER_CARD_ORDER.map((card) => (
          <ProviderCard
            backendStatus={backendStatus}
            card={card}
            key={card}
            onSaveApiKey={saveProviderApiKey}
            onSaveProviders={saveProviderSettings}
            onTest={() => void connectLmStudio()}
            providers={providers}
            radioName={radioName}
            saveState={saveState}
            secrets={secrets}
            status={status}
          />
        ))}
      </div>
    </section>
  )
}
