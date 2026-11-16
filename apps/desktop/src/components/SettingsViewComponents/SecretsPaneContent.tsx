import type { TavilyApiKey } from "@lys/share"
import { LockKeyhole } from "lucide-react"
import { useId, type ReactElement } from "react"

import { Button } from "@/components/ui/button"

import { useLysStore } from "@/lib/store"
import type { SecretsSaveOutcome } from "@/lib/store/secrets-settings"
import { useToolStore } from "@/lib/store/tools"

import TavilyKeyCard from "./TavilyKeyCard"

/**
 * Presents the opening of the Secrets pane: where the other secrets are
 * kept, and how keys are stored.
 *
 * @remarks The application store owns which pane shows; the lead owns no
 * state. The opening line's links show the MCP and Lys panes.
 * @returns The opening line and the storage banner.
 */
function SecretsPaneLead(): ReactElement {
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)

  return (
    <>
      <p className="settings-view__panel-intro">
        A server&apos;s token is kept with that server under{" "}
        <Button
          onClick={() => setSettingsPane("mcp")}
          type="button"
          variant="link"
        >
          MCP
        </Button>
        . A mailbox&apos;s password is kept with its mailbox, in{" "}
        <Button
          onClick={() => setSettingsPane("lys")}
          type="button"
          variant="link"
        >
          Lys
        </Button>{" "}
        for Lys&apos;s and under MCP for yours.
      </p>
      <div className="settings-view__banner">
        <span aria-hidden="true" className="settings-view__pointer-icon">
          <LockKeyhole />
        </span>
        <div className="settings-view__row-lines">
          <span className="settings-view__row-title">
            Kept on this machine, in plain text
          </span>
          <span>
            In <code>settings.json</code> in Lys&apos;s home folder, readable
            only by your user account. Lys&apos;s backend reads a key when it
            lists tools and when a message offers <code>web_search</code>; a
            reply keeps the key it started with.
          </span>
        </div>
      </div>
    </>
  )
}

/**
 * Presents the Secrets pane: where the other secrets are kept, how keys are
 * stored, and the web search service with its API key.
 *
 * @remarks The application store owns the saved key, its save, and its
 * check; the tool store owns the tool list. After a save or removal that
 * succeeded, the pane reads the tool list again before the card resets its
 * edit, in a read that starts after any read in flight, so `web_search`'s
 * availability in the Tools pane follows the saved key rather than a list
 * read before the save. The pane accepts no props and is loaded lazily by
 * the settings view.
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
  const loadToolsAgain = useToolStore((state) => state.loadToolsAgain)
  /**
   * Saves or removes the key and, once saved, reads the tool list again in a
   * read that starts after the read in flight, if any.
   *
   * @param apiKey - Key to save, or null to remove.
   * @returns The save outcome, after the tool list read when it saved.
   */
  async function handleSaveTavilyApiKey(
    apiKey: TavilyApiKey | null
  ): Promise<SecretsSaveOutcome> {
    const outcome = await saveTavilyApiKey(apiKey)
    if (outcome === "saved") await loadToolsAgain()
    return outcome
  }

  return (
    <div className="settings-view__panels">
      <SecretsPaneLead />
      <section aria-labelledby={headingId} className="settings-view__panel">
        <div className="settings-view__panel-intro-head">
          <span className="settings-view__eyebrow">Web search</span>
          <h2 className="settings-view__panel-title" id={headingId}>
            Search service
          </h2>
          <p className="settings-view__panel-intro">
            The <code>web_search</code> tool sends queries to one service at a
            time.
          </p>
        </div>
        <TavilyKeyCard
          keyCheck={keyCheck}
          onSendTavilyKeyCheck={sendTavilyKeyCheck}
          onRemoveTavilyApiKey={() => handleSaveTavilyApiKey(null)}
          onSaveTavilyApiKey={(apiKey) => handleSaveTavilyApiKey(apiKey)}
          saveState={saveState}
          savedApiKey={savedApiKey}
        />
      </section>
    </div>
  )
}
