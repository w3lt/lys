import { Button } from "@/components/ui/button"

/**
 * Completes the current settings pane with the session-only notice and Done
 * action.
 *
 * @remarks Primary category: presentational. The parent owns the `onDone`
 * callback; the component invokes it once synchronously when the button is
 * activated and owns no settings state, effects, persistence, or resources.
 * The footer is a semantic `footer`, and Done is a labelled native button that
 * remains keyboard operable. There are no pending, failed, or empty states.
 *
 * @param props - Parent-owned completion callback for leaving settings.
 * @returns The settings footer.
 */
export default function PaneFooter({
  onDone
}: {
  /** Parent-owned action invoked when the user completes the pane. */
  onDone: () => void
}) {
  return (
    <footer className="settings-view__footer">
      <p>Changes live in this session only. Nothing is written to disk.</p>
      <Button onClick={onDone} type="button">
        Done
      </Button>
    </footer>
  )
}
