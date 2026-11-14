import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import MessageReportList from "@/components/ChatViewComponents/MessageReportList"
import {
  buildJob,
  buildJobCard,
  buildJobReport,
  createFixtureUuidV7
} from "../../support/conversationFixtures"

/** Card of job 1, which names its agent `Nyx`. */
const CARD = buildJobCard(buildJob())

/**
 * Lists the text of every report the list shows, in order.
 *
 * @returns Each item's heading followed by its content.
 */
function listShownReports(): (string | null)[] {
  return within(screen.getByRole("list", { name: "Reports" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent)
}

describe("MessageReportList", () => {
  it("starts collapsed under its label and opens to the reports in delivery order", async () => {
    const user = userEvent.setup()
    render(
      <MessageReportList
        jobCards={[CARD]}
        label="Reports · 2"
        reports={[
          buildJobReport({ kind: "note", content: "Reading three feeds" }),
          buildJobReport({ id: createFixtureUuidV7(69) })
        ]}
      />
    )
    const note = screen.getByText("Reading three feeds")

    expect(note).not.toBeVisible()
    await user.click(screen.getByText("Reports · 2"))

    expect(note).toBeVisible()
    expect(listShownReports()).toEqual([
      "Nyx · News · Progress noteReading three feeds",
      "Nyx · News · ResultDone."
    ])
  })

  it("names the agent by its code when no card names the job", () => {
    render(
      <MessageReportList
        jobCards={[]}
        label="Reports · 1"
        reports={[buildJobReport()]}
      />
    )

    expect(screen.getByText("nyx · News · Result")).toBeInTheDocument()
  })

  it("shows a report's content as written, with its line breaks, not as Markdown", () => {
    render(
      <MessageReportList
        jobCards={[CARD]}
        label="Reports · 1"
        reports={[
          buildJobReport({
            content: "**Done.**\nSee [the list](https://x.test)"
          })
        ]}
      />
    )

    expect(screen.getByText(/^\*\*Done\./).textContent).toBe(
      "**Done.**\nSee [the list](https://x.test)"
    )
    expect(screen.queryByRole("strong")).not.toBeInTheDocument()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })

  it("shows only the heading of a report without content", () => {
    render(
      <MessageReportList
        jobCards={[CARD]}
        label="Reports · 1"
        reports={[buildJobReport({ kind: "stopped", content: "" })]}
      />
    )

    expect(listShownReports()).toEqual(["Nyx · News · Stopped"])
  })
})
