import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import ReplySteps from "@/components/ChatViewComponents/ReplySteps"
import {
  buildChatViewToolCallPart,
  buildToolCallPart
} from "../../support/conversationFixtures"

/** Steps of a reply that searched, then read two pages. */
const STEPS = Object.freeze([
  {
    round: 0,
    text: "Let me search.",
    calls: [
      buildChatViewToolCallPart(
        buildToolCallPart(20, 0, {
          toolName: "web_search",
          argumentText: '{"query":"moths"}',
          status: "succeeded",
          result: "Results",
          sourceNumbers: []
        })
      )
    ]
  },
  {
    round: 1,
    text: "",
    calls: [
      buildChatViewToolCallPart(
        buildToolCallPart(21, 1, {
          toolName: "read_page",
          argumentText: '{"url":"https://a.example/"}',
          status: "running"
        })
      ),
      buildChatViewToolCallPart(
        buildToolCallPart(22, 1, {
          toolName: "read_page",
          argumentText: '{"url":"https://b.example/"}',
          status: "awaiting-approval"
        })
      )
    ]
  }
])

describe("ReplySteps", () => {
  it("counts the steps and calls of a reply still working, collapsed", () => {
    render(<ReplySteps replyNumber={1} steps={STEPS} workedMs={undefined} />)

    expect(screen.getByText("2 steps · 3 tool calls")).toBeInTheDocument()
    expect(screen.getByText("Let me search.")).not.toBeVisible()
  })

  it("says how long an ended reply worked and opens to each step's text and calls in order", async () => {
    const user = userEvent.setup()
    render(<ReplySteps replyNumber={2} steps={STEPS} workedMs={8_400} />)

    await user.click(
      screen.getByLabelText("Worked for 8s · 2 steps · 3 tool calls, reply 2")
    )

    // Each step holds one list of calls; the calls themselves hold none.
    const steps = within(screen.getByRole("list", { name: "Steps" }))
      .getAllByRole("listitem")
      .filter((item) => within(item).queryByRole("list") !== null)
    expect(steps).toHaveLength(2)
    expect(
      within(steps[0] ?? document.body).getByText("Let me search.")
    ).toBeVisible()
    expect(
      steps.map((step) =>
        within(within(step).getByRole("list", { name: "Tool calls" }))
          .getAllByRole("group")
          .map((call) => call.textContent)
      )
    ).toEqual([
      [expect.stringMatching(/^web_searchmothsDone/)],
      [
        expect.stringMatching(/^read_pagehttps:\/\/a\.example\/Running/),
        expect.stringMatching(
          /^read_pagehttps:\/\/b\.example\/Waiting for approval/
        )
      ]
    ])
    expect(
      screen.getByLabelText("read_page https://a.example/ Running, reply 2")
    ).toBeVisible()
  })
})
