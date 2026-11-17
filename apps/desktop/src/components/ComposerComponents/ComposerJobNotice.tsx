import {
  useEffectEvent,
  useLayoutEffect,
  type ReactElement,
  type RefObject
} from "react"

import {
  useFocusedRemovalReport,
  useFocusSuccessor
} from "@/components/focus-target"
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
   * while it has focus and the field is on.
   */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
  /**
   * Host of the composer's New conversation button, which takes focus when
   * Back leaves while it has focus and the message field is off.
   */
  readonly newConversationButtonRef: RefObject<HTMLButtonElement | null>
}

/** Properties accepted by {@link JobNoticeBackButton}. */
type JobNoticeBackButtonProps = {
  /** Whether the button takes focus as it appears. */
  readonly isFocusedOnMount: boolean
  /** Requests that the parent open the job's parent conversation. */
  readonly onOpenParentConversation: () => void
  /**
   * Requests that the notice move focus to the button's successor, because
   * the button leaves while it has focus; called once, in the commit that
   * removes the button. The notice moves focus in that commit, when focus
   * fell to the document.
   */
  readonly onFocusSuccessor: () => void
}

/**
 * Renders the notice's Back button, which leads to the job's parent
 * conversation.
 *
 * @remarks The notice owns whether the button is shown and where focus goes
 * once it leaves. The button takes focus as it appears when asked. When it
 * leaves while it has focus, it asks for its successor through
 * `onFocusSuccessor` before its node is detached, the last moment its focus
 * can be read; a button that leaves without focus asks for nothing.
 * @param props - Whether the button takes focus as it appears, and the open
 * and focus requests.
 * @returns The button, named `Back to the conversation`.
 */
function JobNoticeBackButton(props: JobNoticeBackButtonProps): ReactElement {
  const { isFocusedOnMount, onFocusSuccessor, onOpenParentConversation } = props
  const buttonRef = useFocusedRemovalReport(onFocusSuccessor)

  /**
   * Handles the button's appearance, by focusing it when asked.
   *
   * @param button - The button's node, or null when it was never attached.
   */
  function handleButtonAppearance(button: HTMLElement | null): void {
    if (isFocusedOnMount) button?.focus()
  }
  const handleAppearance = useEffectEvent(handleButtonAppearance)

  useLayoutEffect(() => {
    handleAppearance(buttonRef.current)
  }, [buttonRef])

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
 * States that the shown conversation is a job, whose agent the person cannot
 * talk to, and offers the way back to the conversation it came from.
 *
 * @remarks The parent decides when the notice is shown and owns the open
 * request. The polite status line is always rendered, so it exists before
 * the sentence it announces; it is empty, and the notice takes no room,
 * while the notice is not shown. Back to the conversation sits beside the
 * status line, outside it, and is rendered only while the notice is shown.
 * Back takes focus as it appears when the parent asks, and when Back leaves
 * while it has focus, focus moves to the message field, which is on again
 * in the parent, or to New conversation when the field stays off there. The
 * component owns no other state.
 * @param props - Whether the notice is shown, the delegator's name, the
 * parent-owned open request, whether Back takes focus as it appears, and the
 * hosts of the message field and of New conversation.
 * @returns The composer's job notice.
 */
export default function ComposerJobNotice({
  delegatorName,
  isBackFocusedOnShow,
  isShown,
  messageFieldRef,
  newConversationButtonRef,
  onOpenParentConversation
}: ComposerJobNoticeProps): ReactElement {
  const handleFocusedBackRemoval = useFocusSuccessor(isShown, [
    messageFieldRef,
    newConversationButtonRef
  ])

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
          onFocusSuccessor={handleFocusedBackRemoval}
          onOpenParentConversation={onOpenParentConversation}
        />
      ) : null}
    </div>
  )
}
