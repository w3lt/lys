import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { useLysStore } from "@/lib/store"

import { formatToolSettingsSaveStatus } from "./tool-presentation"

/**
 * Announces the automatic save of the tool choices and offers a retry when
 * a write fails.
 *
 * @remarks The application store owns the save across pane unmounts; the
 * component owns no state or effects. The Tools pane and the MCP pane, which
 * both change tool choices, render it. The status is one polite region named
 * "Tool choices save" that its pane keeps mounted while shown, also while
 * the tools are read again or cannot be read, or while an MCP server's
 * editor is open, so it exists before every change it announces; it is
 * empty while nothing needs saying. After a failure, Retry saving writes the
 * current choices again; until a save works, each switch still applies, but
 * tool calls follow the Just run choices last saved, because the backend
 * reads them from the settings file.
 * @returns The status region and, after a failed save, the retry button.
 */
export function ToolApprovalSaveFeedback(): ReactElement {
  const save = useLysStore((state) => state.toolSettingsSave)
  const saveToolSettings = useLysStore((state) => state.saveToolSettings)

  return (
    <div className="settings-view__tool-status">
      <p
        aria-label="Tool choices save"
        aria-live="polite"
        className="settings-view__note"
        role="status"
      >
        {formatToolSettingsSaveStatus(save)}
      </p>
      {save.status === "failed" ? (
        <Button
          onClick={() => void saveToolSettings()}
          type="button"
          variant="outline"
        >
          Retry saving
        </Button>
      ) : null}
    </div>
  )
}
