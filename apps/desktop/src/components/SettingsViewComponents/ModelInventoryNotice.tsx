import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"

import type { ModelPaneEmptyState } from "./model-pane-presentation"

/** Properties accepted by {@link ModelInventoryNotice}. */
export type ModelInventoryNoticeProps = {
  /** Why no model is listed, and the pane that resolves it. */
  readonly state: ModelPaneEmptyState
  /**
   * Requests that the settings view open another pane; called once per
   * press of the notice's button.
   *
   * @param pane - The pane named by the state.
   */
  readonly onOpenSettingsPane: (pane: "providers" | "runtime") => void
}

/**
 * Says why the Models pane lists no model, in place of the list and details.
 *
 * @remarks The title and body are a status region, so a
 * change is announced; the button names the pane it opens and appears only
 * when a pane resolves the situation.
 * @param props - The situation and the request to open its pane.
 * @returns The notice card.
 */
export default function ModelInventoryNotice({
  state,
  onOpenSettingsPane
}: ModelInventoryNoticeProps): ReactElement {
  const { settingsPane } = state
  return (
    <div className="settings-view__models-notice">
      <div role="status">
        <p className="settings-view__models-notice-title">{state.title}</p>
        {state.body === "" ? null : (
          <p className="settings-view__models-note">{state.body}</p>
        )}
      </div>
      {settingsPane === null ? null : (
        <Button
          onClick={() => onOpenSettingsPane(settingsPane)}
          size="sm"
          type="button"
          variant="outline"
        >
          {settingsPane === "providers" ? "Open Providers" : "Open Runtime"}
        </Button>
      )}
    </div>
  )
}
