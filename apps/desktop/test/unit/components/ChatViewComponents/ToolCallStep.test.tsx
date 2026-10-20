import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import ToolCallStep from "@/components/ChatViewComponents/ToolCallStep"
import { buildToolCallPart } from "../../support/conversationFixtures"

/** Call and arguments of a web search. */
const SEARCH = Object.freeze({
  toolName: "web_search",
  argumentText: '{"query":"night moths","limit":5}'
})

describe("ToolCallStep", () => {
  it("names the tool, what the call is about, and its state, collapsed", () => {
    render(
      <ToolCallStep
        call={buildToolCallPart(20, 0, { ...SEARCH, status: "running" })}
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
        call={buildToolCallPart(20, 0, {
          ...SEARCH,
          status: "succeeded",
          result: "Source [1]\nTitle: Moths",
          sourceNumbers: [1]
        })}
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

  it("shows arguments that are not a JSON object as written", async () => {
    const user = userEvent.setup()
    render(
      <ToolCallStep
        call={buildToolCallPart(20, 0, {
          toolName: "web_search",
          argumentText: '{"query":',
          status: "failed",
          result: "The arguments are not valid JSON."
        })}
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
        call={buildToolCallPart(20, 0, {
          ...SEARCH,
          status: "rejected",
          result: "The person declined this call."
        })}
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
      <ToolCallStep call={buildToolCallPart(20, 0, { ...SEARCH, status })} />
    )

    await user.click(screen.getByText(label))

    expect(screen.getByText("Arguments")).toBeVisible()
    expect(screen.queryByText("Result")).toBeNull()
  })
})
