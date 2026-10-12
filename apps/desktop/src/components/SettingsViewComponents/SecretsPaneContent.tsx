import type { TavilyApiKey } from "@lys/share"
import { useId, type ReactElement } from "react"

import { useLysStore } from "@/lib/store"
import type { SecretsSaveOutcome } from "@/lib/store/secrets-settings"
import { useToolStore } from "@/lib/store/tools"

import TavilyKeyCard from "./TavilyKeyCard"

/**
 * Presents the Secrets pane: the web search service and its API key.
 *
 * @remarks The application store owns the saved key, its save, and its check;
 * the tool store owns the tool list. After a save or removal that succeeded,
 * the pane reads the tool list again before the card resets its edit, so
 * `web_search`'s availability in the Tools pane follows the saved key. The
 * pane accepts no props and is loaded lazily by the settings view.
 * @returns The secrets pane body.
 */
export default function SecretsPane(): ReactElement {
  const headingId = useId()
  const savedApiKey = useLysStore(
    (state) => state.settings.secrets.tavilyApiKey
  )
  const saveState = useLysStore((state) => state.secretsSave)
  const keyCheck = useLysStore((state) => state.tavilyKeyCheck)
  const saveTavilyApiKey = useLysStore((state) => state.saveTavilyApiKey)
  const sendTavilyKeyCheck = useLysStore((state) => state.sendTavilyKeyCheck)
  const loadTools = useToolStore((state) => state.loadTools)

  /**
   * Saves or removes the key and, once saved, reads the tool list again.
   *
   * @param apiKey - Key to save, or null to remove.
   * @returns The save outcome, after the tool list read when it saved.
   */
  async function handleSaveTavilyApiKey(
    apiKey: TavilyApiKey | null
  ): Promise<SecretsSaveOutcome> {
    const outcome = await saveTavilyApiKey(apiKey)
    if (outcome === "saved") await loadTools()
    return outcome
  }

  return (
    <section aria-labelledby={headingId} className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2 id={headingId}>web search service</h2>
        <span>1 service</span>
      </div>
      <p className="settings-view__note">
        The <code>web_search</code> tool sends queries to one service. Give Lys
        its key here.
      </p>
      <TavilyKeyCard
        keyCheck={keyCheck}
        onSendTavilyKeyCheck={sendTavilyKeyCheck}
        onRemoveTavilyApiKey={() => handleSaveTavilyApiKey(null)}
        onSaveTavilyApiKey={(apiKey) => handleSaveTavilyApiKey(apiKey)}
        saveState={saveState}
        savedApiKey={savedApiKey}
      />
    </section>
  )
}
