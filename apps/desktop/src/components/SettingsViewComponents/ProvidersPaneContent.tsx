import { useId, type ReactElement } from "react"

import { useLysStore } from "@/lib/store"

import ProviderCard from "./ProviderCard"
import { LLM_PROVIDER_ORDER } from "./provider-presentation"

/**
 * Presents the Providers pane: one card per model provider, of which one is
 * active and shows where Lys finds it.
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
        <span>{LLM_PROVIDER_ORDER.length} providers</span>
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
        {LLM_PROVIDER_ORDER.map((provider) => (
          <ProviderCard
            key={provider}
            onSaveApiKey={saveProviderApiKey}
            onSaveProviders={saveProviderSettings}
            onTest={() => void connectLmStudio()}
            provider={provider}
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
