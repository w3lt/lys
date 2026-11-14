import { ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import type { SettingsPaneDescriptor } from "@/views/SettingsView/SettingsView"

import PaneFooter from "./PaneFooter"
import PaneHeading from "./PaneHeading"
import PaneSkeleton from "./PaneSkeleton"
import { useSettingsSections } from "./SettingsSectionsContext"

/** Properties accepted by {@link SettingsPaneFrame}. */
export type SettingsPaneFrameProps = {
  /** Whether the lazy pane body is suspended; defaults to `false`. */
  readonly busy?: boolean
  /** Called when the Done action is activated. */
  readonly onDone: () => void
  /** Metadata and lazy body selected by the settings view. */
  readonly pane: SettingsPaneDescriptor
}

/** Properties accepted by {@link SectionsDisclosureButton}. */
type SectionsDisclosureButtonProps = {
  /** Pane whose sections the button opens or closes. */
  readonly pane: SettingsPaneDescriptor
}

/**
 * Presents the button that closes every section of a pane while one is
 * open, and opens them all otherwise.
 *
 * @remarks The settings view owns which sections are open, through
 * {@link useSettingsSections}; the component owns no state. Its label says
 * what pressing it does: `Collapse all` or `Expand all`.
 * @param props - The pane.
 * @returns The button.
 */
function SectionsDisclosureButton({
  pane
}: SectionsDisclosureButtonProps): ReactElement {
  const sections = useSettingsSections()
  const values = pane.sections.map((section) => section.value)
  const isAnyExpanded = values.some((value) =>
    sections.expandedSections.has(value)
  )
  const Icon = isAnyExpanded ? ChevronsDownUp : ChevronsUpDown

  return (
    <Button
      onClick={() => sections.onSectionsExpandedChange(values, !isAnyExpanded)}
      type="button"
      variant="ghost"
    >
      <Icon aria-hidden="true" />
      {isAnyExpanded ? "Collapse all" : "Expand all"}
    </Button>
  )
}

/**
 * Frames one settings pane with its heading, Done action, body, and footer.
 *
 * @remarks The parent owns pane metadata,
 * the Done callback, and the busy state; omitting `busy` means `false`. While
 * busy the `Suspense` fallback renders a separate busy frame, so the heading
 * and Done action stay available without retaining the ready frame's child
 * instances or local state; the closing note, and a pane's Collapse all,
 * are withheld until the body arrives, because they concern controls that
 * are not on screen yet. A pane whose closing note is null gets none from
 * the frame. The frame's width follows the pane's layout. Lazy
 * import failures propagate, as this component declares no error boundary.
 * The frame owns no settings state or persistence.
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
    <div className="settings-view__pane" data-layout={pane.layout}>
      <div className="settings-view__pane-top">
        <PaneHeading busy={busy} note={pane.note} title={pane.label} />
        <div className="settings-view__pane-actions">
          {!busy && pane.sections.length > 0 ? (
            <SectionsDisclosureButton pane={pane} />
          ) : null}
          <Button
            className="settings-view__done"
            onClick={onDone}
            type="button"
            variant="outline"
          >
            Done
          </Button>
        </div>
      </div>

      {busy ? <PaneSkeleton pane={pane.value} /> : <PaneContentComponent />}

      {busy || pane.footNote === null ? null : (
        <PaneFooter note={pane.footNote} />
      )}
    </div>
  )
}
