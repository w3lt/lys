import type { SettingsPaneProps } from "@/views/SettingsView/SettingsView"
import PaneHeading from "./PaneHeading"
import PaneFooter from "./PaneFooter"
import PaneSkeleton from "./PaneSkeleton"

/**
 * Frames one settings pane with its heading, body or loading skeleton, and
 * completion footer.
 *
 * @remarks Primary category: composition/view. The parent owns pane metadata,
 * the Done callback, and the busy state; omission of `busy` means `false`.
 * While busy, the `Suspense` fallback renders a separate busy frame whose
 * heading and footer remain visually available; it does not retain the
 * non-busy frame's child instances or local state. Otherwise it renders the
 * selected no-props lazy body supplied by the pane registry. Lazy import
 * failures propagate because this component has no error boundary. The frame
 * owns no settings state or persistence and delegates semantic heading,
 * status, and button behavior to its children.
 *
 * @param props - Pane metadata, optional pending state, and parent completion
 * callback.
 * @returns The complete settings pane frame.
 */
export default function SettingsPaneFrame({
  busy = false,
  onDone,
  pane
}: {
  /** Whether the lazy pane body is suspended; defaults to `false`. */
  busy?: boolean
  /** Called when the footer Done action is activated. */
  onDone: () => void
  /** Metadata and lazy body selected by the settings view. */
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
