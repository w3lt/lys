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
 * Renders the title, reading marker, and note for one settings pane.
 *
 * @remarks The parent owns every displayed
 * string and the `busy` state; omitting `busy` means `false`. The reading
 * marker is decorative and hidden from assistive technology, because the
 * skeleton below the heading owns the single polite announcement for the wait.
 * The component exposes no callbacks and owns no state, effects, or resources.
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
        <h1>{title}</h1>
        {busy ? (
          <span aria-hidden="true" className="settings-view__reading">
            <span className="settings-view__reading-dot" />
            reading
          </span>
        ) : null}
      </div>
      <p className="settings-view__pane-note">{note}</p>
    </header>
  )
}
