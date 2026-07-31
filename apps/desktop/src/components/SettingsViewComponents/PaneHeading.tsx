export default function PaneHeading({
  busy = false,
  eyebrow,
  title,
  note
}: {
  /** The pane's settings are still being read. */
  busy?: boolean
  eyebrow: string
  title: string
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
