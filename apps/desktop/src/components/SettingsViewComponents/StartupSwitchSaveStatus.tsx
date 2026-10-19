import type { ReactElement } from "react"
import type { RuntimeAutoStartSaveState } from "@/lib/store/runtime-autostart-settings"

/**
 * Formats the status line of the startup switches' save.
 *
 * @param save - Lifecycle of the latest save.
 * @returns The failure sentence after a failed save, and nothing otherwise.
 * Settings are read from disk at each launch, so after a failure the next
 * launch follows the switches last saved, and any switch change saves again.
 */
function formatRuntimeAutoStartSaveStatus(
  save: RuntimeAutoStartSaveState
): string {
  switch (save.status) {
    case "failed":
      return "Lys couldn't save the startup switches. The next launch follows the switches last saved; changing a switch tries again."
    case "idle":
    case "saving":
    case "saved":
      return ""
  }
}

/** Properties accepted by {@link StartupSwitchSaveStatus}. */
type StartupSwitchSaveStatusProps = {
  /** Lifecycle of the latest save of the two startup switches. */
  readonly autoStartSave: RuntimeAutoStartSaveState
}

/**
 * Says when the startup switches of the Runtime pane could not be saved.
 *
 * @remarks The parent owns the save lifecycle; the status owns no state,
 * effect, or store access. A polite status region named "Startup switches
 * save" stays mounted, so the failure is announced when it appears without
 * moving focus. It is empty unless the latest save failed, and empties again
 * when a newer save starts.
 * @param props - Parent-owned save lifecycle.
 * @returns The save's status line.
 */
export default function StartupSwitchSaveStatus({
  autoStartSave
}: StartupSwitchSaveStatusProps): ReactElement {
  return (
    <p
      aria-label="Startup switches save"
      aria-live="polite"
      className="settings-view__note"
      role="status"
    >
      {formatRuntimeAutoStartSaveStatus(autoStartSave)}
    </p>
  )
}
