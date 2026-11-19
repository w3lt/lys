import { createRef } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import ComposerDictationButton from "@/components/ComposerComponents/ComposerDictationButton"
import type { ComposerActivity } from "@/components/ComposerComponents/composer-presentation"
import type { DictationStatus } from "@/lib/dictation"
import { useLysStore } from "@/lib/store"
import { useDictationStore } from "@/lib/store/dictation"
import { useSpeechActivityStore } from "@/lib/store/speech-activity"
import { startHover } from "../../support/rendering"

/** What a case renders the button with. */
type ButtonArrangement = Readonly<{
  /** Chat work that keeps the composer from sending; idle when omitted. */
  activity?: ComposerActivity
  /** Whether the message field is off; on when omitted. */
  isFieldOff?: boolean
  /** Whether the message field exists; it does when omitted. */
  hasField?: boolean
}>

/**
 * Renders the button beside a message field that holds "Hello world".
 *
 * @param arrangement - The composer's activity and the field's state.
 * @returns The spy that stands in for the store's press handler.
 */
function renderButton(arrangement: ButtonArrangement = {}) {
  const handleDictationPress = vi.fn<(cursor: number) => void>()
  useDictationStore.setState({ handleDictationPress })
  const messageFieldRef = createRef<HTMLTextAreaElement>()
  render(
    <>
      {arrangement.hasField === false ? null : (
        <textarea
          aria-label="Message"
          defaultValue="Hello world"
          ref={messageFieldRef}
        />
      )}
      <ComposerDictationButton
        activity={arrangement.activity ?? "idle"}
        isFieldOff={arrangement.isFieldOff ?? false}
        messageFieldRef={messageFieldRef}
      />
    </>
  )
  return handleDictationPress
}

/**
 * Puts the dictation at a status, as the dictation store publishes it.
 *
 * @param status - Where the dictation stands.
 */
function updateDictationStatus(status: DictationStatus): void {
  act(() => {
    useDictationStore.setState({ status })
  })
}

beforeEach(() => {
  const initialDictation = useDictationStore.getInitialState()
  onTestFinished(() => {
    useDictationStore.setState(initialDictation, true)
  })
  useLysStore.setState({
    voiceServerInfo: Object.freeze({ status: "running", problem: null })
  })
  useSpeechActivityStore.setState({ isTalking: false })
})

describe("ComposerDictationButton", () => {
  it("is named Dictate, is not pressed, and can be pressed while Lys may listen", () => {
    renderButton()
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute("aria-pressed")
    expect(button).not.toHaveAccessibleDescription()
  })

  it("starts a dictation at the message field's cursor", async () => {
    const handleDictationPress = renderButton()
    const field = screen.getByRole<HTMLTextAreaElement>("textbox")
    field.setSelectionRange(2, 5)
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Dictate" }))

    expect(handleDictationPress).toHaveBeenCalledExactlyOnceWith(5)
    expect(field).not.toHaveFocus()
  })

  it("starts a dictation at the draft's end when there is no message field", async () => {
    const handleDictationPress = renderButton({ hasField: false })
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Dictate" }))

    expect(handleDictationPress).toHaveBeenCalledExactlyOnceWith(
      Number.POSITIVE_INFINITY
    )
  })

  it.each(["starting", "listening"] as const)(
    "is named Stop dictation and is pressed while a dictation is %s",
    (status) => {
      renderButton()
      updateDictationStatus(status)
      const button = screen.getByRole("button", { name: "Stop dictation" })

      expect(button).toBeEnabled()
      expect(button).toHaveAttribute("aria-pressed", "true")
    }
  )

  it("stops the dictation on a press and moves focus to the message field", async () => {
    const handleDictationPress = renderButton()
    updateDictationStatus("listening")
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Stop dictation" }))

    expect(handleDictationPress).toHaveBeenCalledOnce()
    expect(screen.getByRole("textbox")).toHaveFocus()
  })

  it("can stop a dictation whatever would keep one from starting", () => {
    renderButton({ activity: "awaiting-reply", isFieldOff: true })
    act(() => {
      useLysStore.setState({
        voiceServerInfo: Object.freeze({ status: "stopped", problem: null })
      })
      useSpeechActivityStore.setState({ isTalking: true })
    })
    updateDictationStatus("listening")

    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeEnabled()
  })

  it("is off, without a reason, while the final text is awaited", () => {
    renderButton()
    updateDictationStatus("stopping")
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeDisabled()
    expect(button).not.toHaveAccessibleDescription()
  })

  it("is off and says to start voice while voice does not run", async () => {
    const handleDictationPress = renderButton()
    act(() => {
      useLysStore.setState({
        voiceServerInfo: Object.freeze({ status: "stopped", problem: null })
      })
    })
    const button = screen.getByRole("button", { name: "Dictate" })
    await userEvent.setup().click(button)

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(
      "Start voice in Settings to talk."
    )
    expect(handleDictationPress).not.toHaveBeenCalled()
  })

  it("is off and says to wait while Lys answers", () => {
    renderButton({ activity: "awaiting-reply" })
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription("Wait for Lys to finish.")
  })

  it("is off and says to wait while Lys talks, and can be pressed again once she is silent", () => {
    renderButton()
    act(() => {
      useSpeechActivityStore.setState({ isTalking: true })
    })
    const button = screen.getByRole("button", { name: "Dictate" })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription("Wait for Lys to finish.")
    act(() => {
      useSpeechActivityStore.setState({ isTalking: false })
    })

    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled()
  })

  it("is off and says so while the message field is off", () => {
    renderButton({ isFieldOff: true })
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription("The message field is off.")
  })

  it("is off, without a reason, while a conversation opens", () => {
    renderButton({ activity: "opening-conversation" })
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeDisabled()
    expect(button).not.toHaveAccessibleDescription()
  })

  it("shows its reason to a pointer that rests on the disabled button", () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    renderButton({ activity: "awaiting-reply" })
    const trigger = screen.getByRole("button", {
      name: "Dictate"
    }).parentElement
    if (trigger === null) throw new Error("The button has no tooltip trigger")
    startHover(trigger)
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(
      screen.getAllByText("Wait for Lys to finish.").length
    ).toBeGreaterThan(1)
  })
})
