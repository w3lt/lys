import type { SettingsPaneProps } from "@/views/SettingsView/SettingsView"
import PaneHeading from "./PaneHeading"
import PaneFooter from "./PaneFooter"
import PaneSkeleton from "./PaneSkeleton"

/*
 * Heading and footer frame every pane whether or not its settings have been
 * read, so a pane that is still loading changes only its body: the title stays
 * where the reader is already looking, and Done keeps working throughout.
 */
export default function SettingsPaneFrame({
  busy = false,
  onDone,
  pane
}: {
  busy?: boolean
  onDone: () => void
  pane: SettingsPaneProps
}) {
  const PaneContentComponent = pane.contentComponent
  const children = busy ? (
    <PaneSkeleton pane={pane.value} />
  ) : (
    <PaneContentComponent />
  )

  return (
    <div className="settings-view__pane">
      <PaneHeading
        busy={busy}
        eyebrow={pane.eyebrow}
        note={pane.note}
        title={pane.label}
      />

      {children}

      <PaneFooter onDone={onDone} />
    </div>
  )
}
