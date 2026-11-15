import {
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type RefObject
} from "react"

import { isDocumentFocusLost } from "@/components/SettingsViewComponents/focus-target"
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
   * removes the button, and the bar moves focus in that commit.
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
  const buttonRef = useRef<HTMLElement>(null)

  /**
   * Handles the button's removal, by asking for the message field when the
   * button has focus.
   *
   * @param button - The button's node, still attached, or null when it was
   * never attached.
   */
  function handleButtonRemoval(button: HTMLElement | null): void {
    if (button !== null && button === document.activeElement) {
      onFocusMessageField()
    }
  }
  const handleRemoval = useEffectEvent(handleButtonRemoval)

  useLayoutEffect(() => {
    const button = buttonRef.current
    return () => handleRemoval(button)
  }, [])

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
 * Moves focus to the message field when the bar's Stop all leaves while it
 * has focus.
 *
 * @param isStopShown - Whether the bar shows Stop all; read reactively.
 * @param messageFieldRef - Host of the message field, the successor of a
 * focused Stop all.
 * @returns The callback for a focused Stop all to ask for the field as it
 * leaves; it keeps working for the bar's lifetime.
 * @remarks Stop all leaves once no job works, often right after the person
 * pressed it. A focused Stop all asks for the field in the commit that
 * removes it, and focus moves to the field in the layout phase of that
 * commit, so focus never rests on the document. Nothing moves when Stop all
 * leaves without focus, or when another element holds focus by then. A field
 * that is off, as while generation is unavailable, takes no focus.
 */
function useStopAllFocusSuccessor(
  isStopShown: boolean,
  messageFieldRef: RefObject<HTMLTextAreaElement | null>
): () => void {
  const hasFocusedStopLeftRef = useRef(false)

  /**
   * Handles a change of whether the bar shows Stop all, by moving focus to
   * the field once a focused Stop all left and focus fell back to the
   * document.
   *
   * @param isStopAllShown - Whether the bar shows Stop all after the change.
   */
  function handleStopShownChange(isStopAllShown: boolean): void {
    const hasFocusedStopLeft = hasFocusedStopLeftRef.current
    hasFocusedStopLeftRef.current = false
    if (isStopAllShown || !hasFocusedStopLeft) return

    if (isDocumentFocusLost()) messageFieldRef.current?.focus()
  }
  const handleStopAllShownChange = useEffectEvent(handleStopShownChange)

  /** Handles Stop all's removal while it has focus, by recording it. */
  function handleFocusedStopRemoval(): void {
    hasFocusedStopLeftRef.current = true
  }

  useLayoutEffect(() => {
    handleStopAllShownChange(isStopShown)
  }, [isStopShown])

  return handleFocusedStopRemoval
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
  const handleFocusedStopRemoval = useStopAllFocusSuccessor(
    isShown,
    messageFieldRef
  )

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
