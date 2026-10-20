import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import ReplyReasoning from "@/components/ChatViewComponents/ReplyReasoning"

describe("ReplyReasoning", () => {
  it("starts collapsed under how long the reply thought, and opens to the reasoning", async () => {
    const user = userEvent.setup()
    render(
      <ReplyReasoning
        reasoning={{
          text: "They greet me.\n\nGreet back.",
          isThinking: false,
          durationMs: 4_200
        }}
        replyNumber={3}
      />
    )
    const reasoningText = screen.getByText(/They greet me\./)

    const whileCollapsed = reasoningText
    expect(whileCollapsed).not.toBeVisible()
    await user.click(screen.getByLabelText("Thought for 4s, reply 3"))

    expect(reasoningText).toBeVisible()
    expect(reasoningText.textContent).toBe("They greet me.\n\nGreet back.")
  })

  it("says Thinking while the reply streams its reasoning", () => {
    render(
      <ReplyReasoning
        reasoning={{ text: "Hmm", isThinking: true, durationMs: 0 }}
        replyNumber={1}
      />
    )

    expect(screen.getByText("Thinking")).toBeInTheDocument()
  })
})
