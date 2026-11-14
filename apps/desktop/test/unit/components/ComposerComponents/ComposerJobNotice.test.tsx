import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef, type ReactElement, type RefObject } from "react"
import { describe, expect, it, vi } from "vitest"
import ComposerJobNotice from "@/components/ComposerComponents/ComposerJobNotice"

/**
 * Builds a notice for Caliginia's job beside a message field, as the
 * composer places them.
 *
 * @param isShown - Whether the notice is shown.
 * @param messageFieldRef - Host of the message field.
 * @returns The notice, whose Back takes no focus when it appears, and the
 * field named `Message Lysiptera`.
 */
function buildNoticeWithField(
  isShown: boolean,
  messageFieldRef: RefObject<HTMLTextAreaElement | null>
): ReactElement {
  return (
    <>
      <ComposerJobNotice
        delegatorName="Caliginia"
        isBackFocusedOnShow={false}
        isShown={isShown}
        messageFieldRef={messageFieldRef}
        onOpenParentConversation={vi.fn()}
      />
      <textarea aria-label="Message Lysiptera" ref={messageFieldRef} />
    </>
  )
}

/**
 * Renders a shown notice beside a message field.
 *
 * @returns A call that hides the notice, and the message field.
 */
function startShownNoticeWithField() {
  const messageFieldRef = createRef<HTMLTextAreaElement>()
  const { rerender } = render(buildNoticeWithField(true, messageFieldRef))
  return {
    hideNotice: () => rerender(buildNoticeWithField(false, messageFieldRef)),
    field: screen.getByRole("textbox", { name: "Message Lysiptera" })
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
        onOpenParentConversation={vi.fn()}
      />
    )

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("moves focus to the message field when Back leaves while it has focus", () => {
    const { hideNotice, field } = startShownNoticeWithField()
    act(() =>
      screen.getByRole("button", { name: "Back to the conversation" }).focus()
    )

    hideNotice()

    expect(field).toHaveFocus()
  })

  it("moves no focus when Back leaves without it", () => {
    const { hideNotice, field } = startShownNoticeWithField()

    hideNotice()

    expect(field).not.toHaveFocus()
    expect(document.body).toHaveFocus()
  })
})
