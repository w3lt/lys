import { isDocumentFocusLost } from "@/components/focus-target"

/** Properties accepted by {@link PaneHeading}. */
export type PaneHeadingProps = {
  /** Whether the pane body is currently suspended while its settings load. */
  readonly busy?: boolean
  /** Visible pane title and heading text. */
  readonly title: string
  /** Supporting note shown below the title. */
  readonly note: string
}

/**
 * Focuses the attached pane title when keyboard focus fell back to the
 * document, as after the control that showed the pane was removed with
 * the pane it was in.
 *
 * @param element - Attached title, or null when React detaches it, which
 * is ignored.
 */
function handleTitleAttach(element: HTMLHeadingElement | null): void {
  if (element !== null && isDocumentFocusLost()) element.focus()
}

/**
 * Renders the title, reading marker, and note for one settings pane.
 *
 * @remarks The parent owns every displayed
 * string and the `busy` state; omitting `busy` means `false`. The reading
 * marker is decorative and hidden from assistive technology, because the
 * skeleton below the heading owns the single polite announcement for the wait.
 * The title takes focus when it appears while focus fell back to the
 * document, so a link that shows another pane leaves focus in the view;
 * a rail button keeps focus, because it stays. The component exposes no
 * callbacks and owns no state, effects, or resources.
 *
 * @param props - Heading text and the optional parent-owned pending state.
 * @returns The pane heading.
 */
export default function PaneHeading({
  busy = false,
  title,
  note
}: PaneHeadingProps) {
  return (
    <header className="settings-view__pane-heading">
      <div className="settings-view__pane-heading-title">
        <h1 ref={handleTitleAttach} tabIndex={-1}>
          {title}
        </h1>
        {busy ? (
          <span aria-hidden="true" className="settings-view__reading">
            <span className="settings-view__reading-dot" />
            {"reading"}
          </span>
        ) : null}
      </div>
      <p className="settings-view__pane-note">{note}</p>
    </header>
  )
}
