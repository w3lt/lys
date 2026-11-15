import type { ReactElement, RefObject } from "react"

import {
  useFocusedRemovalReport,
  useFocusSuccessor
} from "@/components/SettingsViewComponents/focus-target"
import { Button } from "@/components/ui/button"

import { formatWorkingJobs } from "./composer-presentation"

/** Properties accepted by {@link ComposerJobsBar}. */
export type ComposerJobsBarProps = {
  /**
   * Number of the shown conversation's jobs that work; 0 while the bar is
   * hidden.
   */
  readonly workingJobCount: number
  /** Requests that the parent stop every working job of the shown conversation. */
  readonly onStopJobs: () => void
  /**
   * Host of the composer's message field, which takes focus when Stop all
   * leaves while it has focus.
   */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
}

/** Properties accepted by {@link JobsBarStopButton}. */
type JobsBarStopButtonProps = {
  /** Requests that the parent stop every working job of the shown conversation. */
  readonly onStopJobs: () => void
  /**
   * Requests that the bar move focus to the message field, because the
   * button leaves while it has focus; called once, in the commit that
   * removes the button. The bar moves focus in that commit, when focus fell
   * to the document.
   */
  readonly onFocusMessageField: () => void
}

/**
 * Renders the bar's Stop all button, which stops every working job of the
 * shown conversation.
 *
 * @remarks The bar owns whether the button is shown and where focus goes
 * once it leaves. When the button leaves while it has focus, it asks for the
 * message field through `onFocusMessageField` before its node is detached,
 * the last moment its focus can be read; a button that leaves without focus
 * asks for nothing.
 * @param props - The stop and focus requests.
 * @returns The button, showing `Stop all` and named `Stop all jobs`.
 */
function JobsBarStopButton({
  onFocusMessageField,
  onStopJobs
}: JobsBarStopButtonProps): ReactElement {
  const buttonRef = useFocusedRemovalReport(onFocusMessageField)

  return (
    <Button
      aria-label="Stop all jobs"
      className="composer__notice-action"
      onClick={onStopJobs}
      ref={buttonRef}
      size="sm"
      type="button"
      variant="outline"
    >
      Stop all
    </Button>
  )
}

/**
 * States how many jobs of the shown conversation work, and offers to stop
 * them all.
 *
 * @remarks The parent decides how many jobs the bar counts, 0 to hide it,
 * and owns the stop request. The polite status line is always rendered, so
 * it exists before the sentence it announces; it is empty, and the bar takes
 * no room, while no job is counted. Stop all sits beside the status line,
 * outside it, and is rendered only while a job is counted. When Stop all
 * leaves while it has focus, focus moves to the message field. The component
 * owns no other state.
 * @param props - How many jobs work, the parent-owned stop request, and the
 * message field's host.
 * @returns The composer's jobs bar.
 */
export default function ComposerJobsBar({
  messageFieldRef,
  onStopJobs,
  workingJobCount
}: ComposerJobsBarProps): ReactElement {
  const isShown = workingJobCount > 0
  const handleFocusedStopRemoval = useFocusSuccessor(isShown, messageFieldRef)

  return (
    <div className="composer__notice" data-shown={isShown ? "" : undefined}>
      <output className="composer__notice-message">
        {isShown ? formatWorkingJobs(workingJobCount) : null}
      </output>
      {isShown ? (
        <JobsBarStopButton
          onFocusMessageField={handleFocusedStopRemoval}
          onStopJobs={onStopJobs}
        />
      ) : null}
    </div>
  )
}
