import type { SettingsPane } from "@/app/types"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

/** One entry in the settings navigation rail. */
export type SettingsRailItem = {
  /** Pane this entry selects. */
  readonly value: SettingsPane
  /** Visible label for the entry. */
  readonly label: string
  /** Two-digit ordinal shown at the end of the row. */
  readonly ordinal: string
}

/** Properties accepted by {@link SettingsViewLeftBar}. */
export type SettingsViewLeftBarProps = {
  /** Rail entries in display order. */
  readonly items: readonly SettingsRailItem[]
  /** Pane whose settings are currently being read, if any. */
  readonly loadingPane?: SettingsPane
  /** Single-line summary of local runtime state shown at the rail's foot. */
  readonly status: string
}

/**
 * Presents the settings navigation rail and the runtime status line.
 *
 * @remarks The parent owns the entries, which
 * pane is being read, and the status summary; selection state and keyboard
 * navigation belong to the surrounding tabs adapter, so this component owns no
 * state, effects, or callbacks. A pane being read shows a breathing marker
 * beside its ordinal; that marker is decorative, because the pane body's own
 * status region announces the wait.
 *
 * @param props - Rail entries, the pane being read, and the status summary.
 * @returns The settings rail.
 */
export default function SettingsViewLeftBar({
  items,
  loadingPane,
  status
}: SettingsViewLeftBarProps) {
  return (
    <TabsList
      aria-label="Settings sections"
      className="settings-view__rail"
      variant="line"
    >
      <span className="settings-view__rail-heading">settings</span>

      {items.map((item) => (
        <TabsTrigger
          className="settings-view__rail-tab"
          key={item.value}
          value={item.value}
        >
          <span>{item.label}</span>
          <span className="settings-view__rail-marks">
            {loadingPane === item.value ? (
              <span aria-hidden="true" className="settings-view__reading-dot" />
            ) : null}
            <span className="settings-view__rail-ordinal">{item.ordinal}</span>
          </span>
        </TabsTrigger>
      ))}

      <p className="settings-view__rail-status">
        <span aria-hidden="true" className="settings-view__rail-status-dot" />
        <span>{status}</span>
      </p>
    </TabsList>
  )
}
