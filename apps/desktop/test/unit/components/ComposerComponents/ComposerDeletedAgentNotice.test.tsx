import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ComposerDeletedAgentNotice from "@/components/ComposerComponents/ComposerDeletedAgentNotice"

describe("ComposerDeletedAgentNotice", () => {
  it("keeps an empty status line and offers nothing while the notice is not shown", () => {
    render(
      <ComposerDeletedAgentNotice
        isShown={false}
        onStartConversation={vi.fn()}
      />
    )

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("states that the agent was deleted and asks the parent for a new conversation", async () => {
    const onStartConversation = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerDeletedAgentNotice
        isShown
        onStartConversation={onStartConversation}
      />
    )

    await user.click(screen.getByRole("button", { name: "New conversation" }))

    expect(screen.getByRole("status")).toHaveTextContent(
      "This conversation's agent was deleted. Start a new one to keep talking."
    )
    expect(onStartConversation).toHaveBeenCalledOnce()
  })

  it("announces the sentence in the status line that was already there", () => {
    const { rerender } = render(
      <ComposerDeletedAgentNotice
        isShown={false}
        onStartConversation={vi.fn()}
      />
    )
    const statusLine = screen.getByRole("status")

    rerender(
      <ComposerDeletedAgentNotice isShown onStartConversation={vi.fn()} />
    )

    expect(screen.getByRole("status")).toBe(statusLine)
    expect(statusLine).not.toBeEmptyDOMElement()
  })
})
