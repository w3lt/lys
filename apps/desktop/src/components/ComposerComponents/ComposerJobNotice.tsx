import {
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type RefObject
} from "react"

import { isDocumentFocusLost } from "@/components/SettingsViewComponents/focus-target"
import { Button } from "@/components/ui/button"

/** Properties accepted by {@link ComposerJobNotice}. */
export type ComposerJobNoticeProps = {
  /** Whether the notice is shown: the shown conversation is a job. */
  readonly isShown: boolean
  /** Name of the agent that gave the job, which wrote its messages. */
  readonly delegatorName: string
  /** Requests that the parent open the job's parent conversation. */
  readonly onOpenParentConversation: () => void
  /**
   * Whether Back takes focus as it appears: the person opened the job from
   * its card, which left with the parent's transcript.
   */
  readonly isBackFocusedOnShow: boolean
  /**
   * Host of the composer's message field, which takes focus when Back leaves
   * while it has focus.
   */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
}

/** Properties accepted by {@link JobNoticeBackButton}. */
type JobNoticeBackButtonProps = {
  /** Whether the button takes focus as it appears. */
  readonly isFocusedOnMount: boolean
  /** Requests that the parent open the job's parent conversation. */
  readonly onOpenParentConversation: () => void
  /**
   * Reports that the button leaves while it has focus; called once, in the
   * commit that removes the button.
   */
  readonly onFocusedRemoval: () => void
}

/**
 * Renders the notice's Back button, which leads to the job's parent
 * conversation.
 *
 * @remarks The notice owns whether the button is shown and where focus goes
 * once it leaves. The button takes focus as it appears when asked. When it
 * leaves while it has focus, it reports that through `onFocusedRemoval`
 * before its node is detached, the last moment its focus can be read; a
 * button that leaves without focus reports nothing.
 * @param props - Whether the button takes focus as it appears, and the open
 * and removal callbacks.
 * @returns The button, named `Back to the conversation`.
 */
function JobNoticeBackButton(props: JobNoticeBackButtonProps): ReactElement {
  const { isFocusedOnMount, onFocusedRemoval, onOpenParentConversation } = props
  const buttonRef = useRef<HTMLElement>(null)

  /**
   * Handles the button's appearance, by focusing it when asked.
   *
   * @param button - The button's node, or null when it was never attached.
   */
  function handleButtonAppearance(button: HTMLElement | null): void {
    if (isFocusedOnMount) button?.focus()
  }

  /**
   * Handles the button's removal, by reporting it when the button has focus.
   *
   * @param button - The button's node, still attached, or null when it was
   * never attached.
   */
  function handleButtonRemoval(button: HTMLElement | null): void {
    if (button !== null && button === document.activeElement) {
      onFocusedRemoval()
    }
  }
  const handleAppearance = useEffectEvent(handleButtonAppearance)
  const handleRemoval = useEffectEvent(handleButtonRemoval)

  useLayoutEffect(() => {
    const button = buttonRef.current
    handleAppearance(button)
    return () => handleRemoval(button)
  }, [])

  return (
    <Button
      className="composer__notice-action"
      onClick={onOpenParentConversation}
      ref={buttonRef}
      size="sm"
      type="button"
      variant="outline"
    >
      Back to the conversation
    </Button>
  )
}

/**
 * Moves focus to the message field when the notice's Back leaves while it
 * has focus.
 *
 * @param isShown - Whether the notice shows Back; read reactively.
 * @param messageFieldRef - Host of the message field, Back's successor.
 * @returns The callback for Back to report its focused removal; it keeps
 * working for the notice's lifetime.
 * @remarks Back leaves once the shown conversation is no longer a job,
 * mostly because the person pressed it. It reports its focused removal in
 * the commit that removes it, and focus moves to the field in the layout
 * phase of that commit, once the field the job turned off is on again, so
 * focus never rests on the document. Nothing moves when Back leaves without
 * focus, or when another element holds focus by then. A field that is still
 * off, as while generation is unavailable, takes no focus.
 */
function useBackFocusSuccessor(
  isShown: boolean,
  messageFieldRef: RefObject<HTMLTextAreaElement | null>
): () => void {
  const hasFocusedBackLeftRef = useRef(false)

  /**
   * Handles a change of whether the notice is shown, by moving focus to the
   * field once a focused Back left and focus fell back to the document.
   *
   * @param isNoticeShown - Whether the notice is shown after the change.
   */
  function handleShownChange(isNoticeShown: boolean): void {
    const hasFocusedBackLeft = hasFocusedBackLeftRef.current
    hasFocusedBackLeftRef.current = false
    if (isNoticeShown || !hasFocusedBackLeft) return

    if (isDocumentFocusLost()) messageFieldRef.current?.focus()
  }
  const handleNoticeShownChange = useEffectEvent(handleShownChange)

  /** Handles Back's removal while it has focus, by recording it. */
  function handleFocusedBackRemoval(): void {
    hasFocusedBackLeftRef.current = true
  }

  useLayoutEffect(() => {
    handleNoticeShownChange(isShown)
  }, [isShown])

  return handleFocusedBackRemoval
}

/**
 * States that the shown conversation is a job, whose agent the person cannot
 * talk to, and offers the way back to the conversation it came from.
 *
 * @remarks The parent decides when the notice is shown and owns the open
 * request. The polite status line is always rendered, so it exists before
 * the sentence it announces; it is empty, and the notice takes no room,
 * while the notice is not shown. Back to the conversation sits beside the
 * status line, outside it, and is rendered only while the notice is shown.
 * Back takes focus as it appears when the parent asks, and when Back leaves
 * while it has focus, focus moves to the message field once the field is on
 * again. The component owns no other state.
 * @param props - Whether the notice is shown, the delegator's name, the
 * parent-owned open request, whether Back takes focus as it appears, and the
 * message field's host.
 * @returns The composer's job notice.
 */
export default function ComposerJobNotice({
  delegatorName,
  isBackFocusedOnShow,
  isShown,
  messageFieldRef,
  onOpenParentConversation
}: ComposerJobNoticeProps): ReactElement {
  const handleFocusedBackRemoval = useBackFocusSuccessor(
    isShown,
    messageFieldRef
  )

  return (
    <div className="composer__notice" data-shown={isShown ? "" : undefined}>
      <output className="composer__notice-message">
        {isShown
          ? `This is a job from ${delegatorName}. You can read it and stop it.`
          : null}
      </output>
      {isShown ? (
        <JobNoticeBackButton
          isFocusedOnMount={isBackFocusedOnShow}
          onFocusedRemoval={handleFocusedBackRemoval}
          onOpenParentConversation={onOpenParentConversation}
        />
      ) : null}
    </div>
  )
}
