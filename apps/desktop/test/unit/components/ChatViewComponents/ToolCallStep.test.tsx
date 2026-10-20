import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import ToolCallStep from "@/components/ChatViewComponents/ToolCallStep"
import type { ChatViewToolCallReplyPart } from "@/lib/store/chat-view/reply-parts"
import {
  buildChatViewToolCallPart,
  buildToolCallPart,
  type ToolCallPartFixture
} from "../../support/conversationFixtures"

/** Call and arguments of a web search. */
const SEARCH = Object.freeze({
  toolName: "web_search",
  argumentText: '{"query":"night moths","limit":5}'
})

/** Position of the fixture call's reply among the transcript's replies. */
const REPLY_NUMBER = 2

/**
 * Builds the fixture call as the chat view holds it.
 *
 * @param call - Tool name, argument text, and state of the call.
 * @returns A call of round 0 with its parsed arguments.
 */
function buildChatViewCall(
  call: ToolCallPartFixture
): ChatViewToolCallReplyPart {
  return buildChatViewToolCallPart(buildToolCallPart(20, 0, call))
}

describe("ToolCallStep", () => {
  it("names the tool, what the call is about, and its state, collapsed", () => {
    render(
      <ToolCallStep
        call={buildChatViewCall({ ...SEARCH, status: "running" })}
        replyNumber={REPLY_NUMBER}
      />
    )

    expect(screen.getByRole("group")).toHaveTextContent(
      /^web_searchnight mothsRunningArguments/
    )
    expect(screen.getByText("Running")).toBeVisible()
    expect(screen.getByText("Arguments")).not.toBeVisible()
  })

  it("opens to the named arguments and the result the model read", async () => {
    const user = userEvent.setup()
    render(
      <ToolCallStep
        call={buildChatViewCall({
          ...SEARCH,
          status: "succeeded",
          result: "Source [1]\nTitle: Moths",
          sourceNumbers: [1]
        })}
        replyNumber={REPLY_NUMBER}
      />
    )

    await user.click(screen.getByText("Done"))

    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(
      ["query", "limit"]
    )
    expect(
      screen.getAllByRole("definition").map((value) => value.textContent)
    ).toEqual(["night moths", "5"])
    for (const term of screen.getAllByRole("term")) expect(term).toBeVisible()
    expect(screen.getByText("Result")).toBeVisible()
    expect(screen.getByText(/^Source \[1\]/).textContent).toBe(
      "Source [1]\nTitle: Moths"
    )
  })

  it("names its summary by the call, its state, and its reply", async () => {
    const user = userEvent.setup()
    render(
      <ToolCallStep
        call={buildChatViewCall({ ...SEARCH, status: "running" })}
        replyNumber={REPLY_NUMBER}
      />
    )

    await user.click(
      screen.getByLabelText("web_search night moths Running, reply 2")
    )

    expect(screen.getByText("Arguments")).toBeVisible()
  })

  it("lets the keyboard reach each long text as a region named by its label, its call, and its reply", async () => {
    const user = userEvent.setup()
    render(
      <ToolCallStep
        call={buildChatViewCall({
          toolName: "web_search",
          argumentText: '{"query":',
          status: "failed",
          result: "The arguments are not valid JSON."
        })}
        replyNumber={REPLY_NUMBER}
      />
    )

    await user.click(screen.getByText("Failed"))
    await user.tab()

    const argumentsText = screen.getByRole("region", {
      name: "Arguments of web_search, reply 2"
    })
    expect(argumentsText).toHaveFocus()
    expect(argumentsText).toHaveTextContent('{"query":')
    await user.tab()
    const resultText = screen.getByRole("region", {
      name: "Result of web_search, reply 2"
    })
    expect(resultText).toHaveFocus()
    expect(resultText).toHaveTextContent("The arguments are not valid JSON.")
  })

  it("shows arguments that are not a JSON object as written", async () => {
    const user = userEvent.setup()
    render(
      <ToolCallStep
        call={buildChatViewCall({
          toolName: "web_search",
          argumentText: '{"query":',
          status: "failed",
          result: "The arguments are not valid JSON."
        })}
        replyNumber={REPLY_NUMBER}
      />
    )

    await user.click(screen.getByText("Failed"))

    expect(screen.getByText('{"query":')).toBeVisible()
    expect(screen.getByText("The arguments are not valid JSON.")).toBeVisible()
  })

  it("says a rejected call was rejected and shows the rejection", async () => {
    const user = userEvent.setup()
    render(
      <ToolCallStep
        call={buildChatViewCall({
          ...SEARCH,
          status: "rejected",
          result: "The person declined this call."
        })}
        replyNumber={REPLY_NUMBER}
      />
    )

    await user.click(screen.getByText("Rejected"))

    expect(screen.getByText("Rejection")).toBeVisible()
    expect(screen.getByText("The person declined this call.")).toBeVisible()
  })

  it.each([
    ["awaiting-approval", "Waiting for approval"],
    ["interrupted", "Stopped"]
  ] as const)("shows no result for a %s call", async (status, label) => {
    const user = userEvent.setup()
    render(
      <ToolCallStep
        call={buildChatViewCall({ ...SEARCH, status })}
        replyNumber={REPLY_NUMBER}
      />
    )

    await user.click(screen.getByText(label))

    expect(screen.getByText("Arguments")).toBeVisible()
    expect(screen.queryByText("Result")).toBeNull()
  })
})
