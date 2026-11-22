import { createRef } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { ComposerActivity } from "@/components/ComposerComponents/composer-presentation"
import type { DictationStatus } from "@/lib/dictation/composer-dictation"
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
 * Loads fresh stores and the button, and renders the button beside a message
 * field that holds "Hello world", while voice runs and Lys is silent.
 *
 * @param arrangement - The composer's activity and the field's state.
 * @returns The stores the button reads, and the spy that stands in for the
 * dictation store's press handler.
 */
async function renderFreshButton(arrangement: ButtonArrangement = {}) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useDictationStore } = await import("@/lib/store/dictation")
  const { useSpeechActivityStore } = await import("@/lib/store/speech-activity")
  const { default: ComposerDictationButton } =
    await import("@/components/ComposerComponents/ComposerDictationButton")
  const handleDictationPress = vi.fn<(cursor: number) => void>()
  useDictationStore.setState({ handleDictationPress })
  useLysStore.setState({
    voiceServerInfo: Object.freeze({ status: "running", problem: null })
  })
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
  return {
    useLysStore,
    useDictationStore,
    useSpeechActivityStore,
    handleDictationPress
  }
}

/** The stores and the press spy of one case's rendered button. */
type RenderedButton = Awaited<ReturnType<typeof renderFreshButton>>

/**
 * Puts the dictation at a status, as the dictation store publishes it.
 *
 * @param rendered - The case's stores.
 * @param status - Where the dictation stands.
 */
function updateDictationStatus(
  rendered: RenderedButton,
  status: DictationStatus
): void {
  act(() => {
    rendered.useDictationStore.setState({ status })
  })
}

describe("ComposerDictationButton", () => {
  it("is named Dictate, is no toggle, and can be pressed while Lys may listen", async () => {
    await renderFreshButton()
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute("aria-pressed")
    expect(button).not.toHaveAccessibleDescription()
  })

  it("starts a dictation at the message field's cursor", async () => {
    const { handleDictationPress } = await renderFreshButton()
    const field = screen.getByRole<HTMLTextAreaElement>("textbox")
    field.setSelectionRange(2, 5)
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Dictate" }))

    expect(handleDictationPress).toHaveBeenCalledExactlyOnceWith(5)
    expect(field).not.toHaveFocus()
  })

  it("starts a dictation at the draft's end when there is no message field", async () => {
    const { handleDictationPress } = await renderFreshButton({
      hasField: false
    })
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Dictate" }))

    expect(handleDictationPress).toHaveBeenCalledExactlyOnceWith(
      Number.POSITIVE_INFINITY
    )
  })

  it.each(["starting", "listening"] as const)(
    "is named Stop dictation, and is no toggle, while a dictation is %s",
    async (status) => {
      updateDictationStatus(await renderFreshButton(), status)
      const button = screen.getByRole("button", { name: "Stop dictation" })

      expect(button).toBeEnabled()
      expect(button).not.toHaveAttribute("aria-pressed")
    }
  )

  it("stops the dictation on a press and moves focus to the message field", async () => {
    const rendered = await renderFreshButton()
    updateDictationStatus(rendered, "listening")
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Stop dictation" }))

    expect(rendered.handleDictationPress).toHaveBeenCalledOnce()
    expect(screen.getByRole("textbox")).toHaveFocus()
  })

  it("can stop a dictation whatever would keep one from starting", async () => {
    const rendered = await renderFreshButton({
      activity: "awaiting-reply",
      isFieldOff: true
    })
    act(() => {
      rendered.useLysStore.setState({
        voiceServerInfo: Object.freeze({ status: "stopped", problem: null })
      })
      rendered.useSpeechActivityStore.setState({ isTalking: true })
    })
    updateDictationStatus(rendered, "listening")

    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeEnabled()
  })

  it("is off, without a reason, while the final text is awaited", async () => {
    updateDictationStatus(await renderFreshButton(), "stopping")
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeDisabled()
    expect(button).not.toHaveAccessibleDescription()
  })

  it("is off and says to start voice while voice does not run", async () => {
    const { useLysStore, handleDictationPress } = await renderFreshButton()
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

  it("is off and says to wait while Lys answers", async () => {
    await renderFreshButton({ activity: "awaiting-reply" })
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription("Wait for Lys to finish.")
  })

  it("is off and says to wait while Lys talks, and can be pressed again once she is silent", async () => {
    const { useSpeechActivityStore } = await renderFreshButton()
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

  it("is off and says so while the message field is off", async () => {
    await renderFreshButton({ isFieldOff: true })
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription("The message field is off.")
  })

  it("is off, without a reason, while a conversation opens", async () => {
    await renderFreshButton({ activity: "opening-conversation" })
    const button = screen.getByRole("button", { name: "Dictate" })

    expect(button).toBeDisabled()
    expect(button).not.toHaveAccessibleDescription()
  })

  it("shows its reason to a pointer that rests on the disabled button", async () => {
    await renderFreshButton({ activity: "awaiting-reply" })
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
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
