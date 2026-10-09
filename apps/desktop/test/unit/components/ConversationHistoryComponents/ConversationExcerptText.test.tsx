import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import ConversationExcerptText from "@/components/ConversationHistoryComponents/ConversationExcerptText"

describe("ConversationExcerptText", () => {
  it("says there are no messages without an excerpt", () => {
    render(<ConversationExcerptText excerpt={null} highlightQuery="" />)

    expect(screen.getByText("no messages")).toBeInTheDocument()
  })

  it("prefixes the user's own words and leaves Lys's unprefixed", () => {
    const { rerender, container } = render(
      <ConversationExcerptText
        excerpt={{ speaker: "user", text: "How do I start?" }}
        highlightQuery=""
      />
    )

    expect(container).toHaveTextContent(/^you: How do I start\?$/)

    rerender(
      <ConversationExcerptText
        excerpt={{ speaker: "assistant", text: "Press Start." }}
        highlightQuery=""
      />
    )

    expect(container).toHaveTextContent(/^Press Start\.$/)
  })

  it("marks the first case-insensitive match of the search", () => {
    const { container } = render(
      <ConversationExcerptText
        excerpt={{
          speaker: "assistant",
          text: "Open LM Studio, then lm studio"
        }}
        highlightQuery="lm studio"
      />
    )

    const marks = container.querySelectorAll("mark")
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe("LM Studio")
    expect(container).toHaveTextContent("Open LM Studio, then lm studio")
  })

  it("marks nothing when the search does not match", () => {
    const { container } = render(
      <ConversationExcerptText
        excerpt={{ speaker: "assistant", text: "Press Start." }}
        highlightQuery="stop"
      />
    )

    expect(container.querySelector("mark")).toBeNull()
  })
})
