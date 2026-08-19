/**
 * Renders the stable eyebrow, title, note, and optional pending indicator for
 * one settings pane.
 *
 * @remarks Primary category: presentational. The parent owns all displayed
 * strings and the `busy` state; omission of `busy` means `false`. When busy,
 * the component adds a visual-only loading label while the pane body is
 * suspended, leaving announcement responsibility to the skeleton status
 * region. It renders a semantic `header` and heading, exposes no callbacks,
 * state, effects, refs, persistence, or failure recovery.
 *
 * @param props - Pane heading text and the optional parent-owned pending state.
 * @returns The pane heading landmark and its optional visual loading cue.
 */
export default function PaneHeading({
  busy = false,
  eyebrow,
  title,
  note
}: {
  /** Whether the pane body is currently suspended while loading. */
  busy?: boolean
  /** Short category label shown above the title. */
  eyebrow: string
  /** Visible pane title and heading text. */
  title: string
  /** Supporting note shown below the title. */
  note: string
}) {
  return (
    <header className="settings-view__pane-heading">
      <p>{eyebrow}</p>
      <div className="settings-view__pane-heading-title">
        <h1>{title}</h1>
        {/*
         * Decoration only: the placeholder below the heading is what announces
         * the wait, and a second live region here would repeat it.
         */}
        {busy ? (
          <span aria-hidden="true" className="settings-view__reading">
            <span className="settings-view__reading-dot" />
            loading
          </span>
        ) : null}
      </div>
      <span>{note}</span>
    </header>
  )
}
