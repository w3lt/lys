import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import UserMessage from "@/components/ChatViewComponents/UserMessage"
import { buildUserMessage } from "../../support/conversationFixtures"

describe("UserMessage", () => {
  it("shows the message as written under the you label", () => {
    render(
      <UserMessage message={buildUserMessage(1, "Is **this** markdown?")} />
    )

    const message = screen.getByRole("article")
    expect(message).toHaveTextContent(/^you/)
    expect(message).toHaveTextContent("Is **this** markdown?")
    expect(screen.queryByRole("strong")).not.toBeInTheDocument()
  })

  it("keeps the decorative portrait out of the accessibility tree", () => {
    render(<UserMessage message={buildUserMessage(1, "Hello")} />)

    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })
})
