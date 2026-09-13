/** Properties accepted by {@link PaneFooter}. */
export type PaneFooterProps = {
  /** Closing note explaining what the pane's settings actually affect. */
  readonly note: string
}

/**
 * Closes one settings pane with the note explaining what its settings do.
 *
 * @remarks The parent owns the note and
 * decides whether to render the footer at all; an empty note renders an empty
 * footer rather than collapsing the pane's bottom spacing. The component owns
 * no state, callbacks, effects, or resources.
 *
 * @param props - Closing note for the current pane.
 * @returns The settings pane footer.
 */
export default function PaneFooter({ note }: PaneFooterProps) {
  return (
    <footer className="settings-view__footer">
      <p>{note}</p>
    </footer>
  )
}
