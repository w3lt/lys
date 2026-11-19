import { useId } from "react"
import type { ReactElement, RefObject } from "react"
import { Mic } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { useLysStore } from "@/lib/store"
import { useDictationStore } from "@/lib/store/dictation"
import { useSpeechActivityStore } from "@/lib/store/speech-activity"

import { calculateDictationButtonState } from "./dictation-presentation"
import type { ComposerActivity } from "./composer-presentation"

/** Properties accepted by {@link ComposerDictationButton}. */
type ComposerDictationButtonProps = {
  /** Chat work that keeps the composer from sending. */
  readonly activity: ComposerActivity
  /**
   * Whether the message field is off: the model cannot answer, the agent was
   * deleted, or the conversation is a job.
   */
  readonly isFieldOff: boolean
  /**
   * Parent-owned host of the message field, read for the cursor when a
   * dictation starts, and focused when the person stops one.
   */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
}

/**
 * Starts and stops a dictation into the message field.
 *
 * @remarks The dictation store owns the dictation; the application store
 * owns whether voice runs, and the speech activity store whether Lys is
 * talking. The component owns no state. Named Dictate, the button starts a
 * dictation at the field's cursor, or at the draft's end when the field has
 * none. While a dictation starts or listens it is named Stop dictation and
 * marked as listening for its style, and a press stops the dictation and
 * moves focus to the message field, where the text lands and the button
 * turns off for the wait. The name carries the state, as Send's does when it
 * turns into Stop, so the button is no toggle and exposes no pressed state.
 * The button is off while the final text is awaited, while the field is
 * off, while a conversation opens, while voice does not run, and while Lys
 * answers or talks; a reason that does not pass on its own is the button's
 * description and its hover text. The hover text otherwise names the button.
 * @param props - The composer's activity, whether the field is off, and the
 * message field's host.
 * @returns The dictation button, with its reason when it has one.
 */
export default function ComposerDictationButton({
  activity,
  isFieldOff,
  messageFieldRef
}: ComposerDictationButtonProps): ReactElement {
  const status = useDictationStore((state) => state.status)
  const handleDictationPress = useDictationStore(
    (state) => state.handleDictationPress
  )
  const isVoiceRunning = useLysStore(
    (state) => state.voiceServerInfo.status === "running"
  )
  const isTalking = useSpeechActivityStore((state) => state.isTalking)
  const reasonId = useId()
  const button = calculateDictationButtonState({
    status,
    isFieldOff,
    isOpeningConversation: activity === "opening-conversation",
    isVoiceRunning,
    isLysBusy: activity === "awaiting-reply" || isTalking
  })
  const isListening = button.kind === "listening"
  const label = isListening ? "Stop dictation" : "Dictate"
  const reason = button.kind === "unavailable" ? button.reason : undefined

  /**
   * Starts a dictation at the field's cursor, or stops the running one and
   * moves focus to the field.
   */
  function handleClick(): void {
    const field = messageFieldRef.current
    handleDictationPress(field?.selectionEnd ?? Number.POSITIVE_INFINITY)
    if (isListening) field?.focus()
  }

  return (
    <>
      <Tooltip description={reason ?? label}>
        <Button
          aria-describedby={reason === undefined ? undefined : reasonId}
          className="composer__dictation"
          data-listening={isListening ? "" : undefined}
          disabled={button.kind === "unavailable"}
          onClick={handleClick}
          size="icon"
          type="button"
          variant="outline"
        >
          <Mic aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </Button>
      </Tooltip>
      {reason === undefined ? null : (
        <span className="sr-only" id={reasonId}>
          {reason}
        </span>
      )}
    </>
  )
}
