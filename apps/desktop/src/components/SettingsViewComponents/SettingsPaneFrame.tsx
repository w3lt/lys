import { Button } from "@/components/ui/button"
import type { SettingsPaneDescriptor } from "@/views/SettingsView/SettingsView"

import PaneFooter from "./PaneFooter"
import PaneHeading from "./PaneHeading"
import PaneSkeleton from "./PaneSkeleton"

/** Properties accepted by {@link SettingsPaneFrame}. */
export type SettingsPaneFrameProps = {
  /** Whether the lazy pane body is suspended; defaults to `false`. */
  readonly busy?: boolean
  /** Called when the Done action is activated. */
  readonly onDone: () => void
  /** Metadata and lazy body selected by the settings view. */
  readonly pane: SettingsPaneDescriptor
}

/**
 * Frames one settings pane with its heading, Done action, body, and footer.
 *
 * @remarks The parent owns pane metadata,
 * the Done callback, and the busy state; omitting `busy` means `false`. While
 * busy the `Suspense` fallback renders a separate busy frame, so the heading
 * and Done action stay available without retaining the ready frame's child
 * instances or local state; the closing note is withheld until the body
 * arrives, because it describes controls that are not on screen yet. Lazy
 * import failures propagate, as this component declares no error boundary. The
 * frame owns no settings state or persistence.
 *
 * @param props - Pane metadata, optional pending state, and the Done callback.
 * @returns The complete settings pane frame.
 */
export default function SettingsPaneFrame({
  busy = false,
  onDone,
  pane
}: SettingsPaneFrameProps) {
  const PaneContentComponent = pane.contentComponent

  return (
    <div className="settings-view__pane">
      <div className="settings-view__pane-top">
        <PaneHeading busy={busy} note={pane.note} title={pane.label} />
        <Button
          className="settings-view__done"
          onClick={onDone}
          type="button"
          variant="outline"
        >
          Done
        </Button>
      </div>

      {busy ? <PaneSkeleton pane={pane.value} /> : <PaneContentComponent />}

      {busy ? null : <PaneFooter note={pane.footNote} />}
    </div>
  )
}
