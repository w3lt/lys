import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ConversationHistoryNotice from "@/components/ConversationHistoryComponents/ConversationHistoryNotice"

describe("ConversationHistoryNotice", () => {
  it("announces a message politely, without an action", () => {
    render(
      <ConversationHistoryNotice
        kind="message"
        message="Reading past conversations…"
      />
    )

    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading past conversations…"
    )
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("offers to read the list again once per press after a failure", async () => {
    const onRetryConversationHistory = vi.fn()
    const user = userEvent.setup()
    render(
      <ConversationHistoryNotice
        kind="failure"
        message="Past conversations could not be read."
        onRetryConversationHistory={onRetryConversationHistory}
      />
    )

    await user.click(screen.getByRole("button", { name: "Try again" }))

    expect(screen.getByRole("status")).toHaveTextContent(
      "Past conversations could not be read."
    )
    expect(onRetryConversationHistory).toHaveBeenCalledOnce()
  })
})
