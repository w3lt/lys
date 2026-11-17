import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef, type ReactElement, type RefObject } from "react"
import { describe, expect, it, vi } from "vitest"
import ComposerJobNotice from "@/components/ComposerComponents/ComposerJobNotice"

/** Hosts of the composer's controls that may take focus after Back. */
type SuccessorHosts = {
  /** Host of the message field. */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
  /** Host of the New conversation button. */
  readonly newConversationButtonRef: RefObject<HTMLButtonElement | null>
}

/**
 * Builds a notice for Caliginia's job before a message field and a New
 * conversation button, as the composer places them.
 *
 * @param isShown - Whether the notice is shown.
 * @param isFieldOff - Whether the message field is off.
 * @param hosts - Hosts of the field and of the button.
 * @returns The notice, whose Back takes no focus when it appears, the field
 * named `Message Lysiptera`, and the button.
 */
function buildNoticeWithControls(
  isShown: boolean,
  isFieldOff: boolean,
  hosts: SuccessorHosts
): ReactElement {
  return (
    <>
      <ComposerJobNotice
        delegatorName="Caliginia"
        isBackFocusedOnShow={false}
        isShown={isShown}
        messageFieldRef={hosts.messageFieldRef}
        newConversationButtonRef={hosts.newConversationButtonRef}
        onOpenParentConversation={vi.fn()}
      />
      <textarea
        aria-label="Message Lysiptera"
        disabled={isFieldOff}
        ref={hosts.messageFieldRef}
      />
      <button ref={hosts.newConversationButtonRef} type="button">
        New conversation
      </button>
    </>
  )
}

/**
 * Renders a shown notice before a message field and a New conversation
 * button.
 *
 * @param isFieldOff - Whether the message field is off once the notice is
 * hidden; it does not change.
 * @returns A call that hides the notice, the message field, and the New
 * conversation button.
 */
function startShownNoticeWithControls(isFieldOff: boolean) {
  const hosts: SuccessorHosts = {
    messageFieldRef: createRef(),
    newConversationButtonRef: createRef()
  }
  const { rerender } = render(buildNoticeWithControls(true, isFieldOff, hosts))
  const field = screen.getByRole("textbox", { name: "Message Lysiptera" })
  const newConversation = screen.getByRole("button", {
    name: "New conversation"
  })
  return {
    hideNotice: () =>
      rerender(buildNoticeWithControls(false, isFieldOff, hosts)),
    field,
    newConversation
  }
}

describe("ComposerJobNotice", () => {
  it("says whose job it is and offers the way back", async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerJobNotice
        delegatorName="Caliginia"
        isBackFocusedOnShow={false}
        isShown
        messageFieldRef={createRef()}
        newConversationButtonRef={createRef()}
        onOpenParentConversation={onOpen}
      />
    )

    expect(screen.getByRole("status")).toHaveTextContent(
      "This is a job from Caliginia. You can read it and stop it."
    )
    await user.click(
      screen.getByRole("button", { name: "Back to the conversation" })
    )
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("takes no room while it is not shown", () => {
    render(
      <ComposerJobNotice
        delegatorName="Caliginia"
        isBackFocusedOnShow={false}
        isShown={false}
        messageFieldRef={createRef()}
        newConversationButtonRef={createRef()}
        onOpenParentConversation={vi.fn()}
      />
    )

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("moves focus to the message field when Back leaves while it has focus", () => {
    const { hideNotice, field } = startShownNoticeWithControls(false)
    act(() =>
      screen.getByRole("button", { name: "Back to the conversation" }).focus()
    )

    hideNotice()

    expect(field).toHaveFocus()
  })

  it("moves focus to New conversation when Back leaves with focus while the field is off", () => {
    const { hideNotice, newConversation } = startShownNoticeWithControls(true)
    act(() =>
      screen.getByRole("button", { name: "Back to the conversation" }).focus()
    )

    hideNotice()

    expect(newConversation).toHaveFocus()
  })

  it("moves no focus when Back leaves without it", () => {
    const { hideNotice, field } = startShownNoticeWithControls(false)

    hideNotice()

    expect(field).not.toHaveFocus()
    expect(document.body).toHaveFocus()
  })
})
