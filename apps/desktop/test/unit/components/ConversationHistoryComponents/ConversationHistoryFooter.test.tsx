import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ConversationHistoryFooter from "@/components/ConversationHistoryComponents/ConversationHistoryFooter"

describe("ConversationHistoryFooter", () => {
  it("shows the keyboard hint under the identifier fields refer to", () => {
    render(
      <ConversationHistoryFooter
        hint="Arrows move · Enter continues · F2 renames"
        hintId="history-hint"
        mutationError={undefined}
        onStartConversation={vi.fn()}
      />
    )

    expect(document.getElementById("history-hint")).toHaveTextContent(
      "Arrows move · Enter continues · F2 renames"
    )
  })

  it("keeps an empty polite status until a change fails, then announces it", () => {
    const { rerender } = render(
      <ConversationHistoryFooter
        hint="hint"
        hintId="history-hint"
        mutationError={undefined}
        onStartConversation={vi.fn()}
      />
    )
    const status = screen.getByRole("status")
    expect(status).toBeEmptyDOMElement()
    expect(status).toHaveAttribute("aria-live", "polite")

    rerender(
      <ConversationHistoryFooter
        hint="hint"
        hintId="history-hint"
        mutationError="The conversation could not be renamed."
        onStartConversation={vi.fn()}
      />
    )

    expect(screen.getByRole("status")).toBe(status)
    expect(status).toHaveTextContent("The conversation could not be renamed.")
  })

  it("starts a new conversation once per press", async () => {
    const onStartConversation = vi.fn()
    const user = userEvent.setup()
    render(
      <ConversationHistoryFooter
        hint="hint"
        hintId="history-hint"
        mutationError={undefined}
        onStartConversation={onStartConversation}
      />
    )

    await user.click(screen.getByRole("button", { name: "Start a new one" }))

    expect(onStartConversation).toHaveBeenCalledOnce()
  })
})
