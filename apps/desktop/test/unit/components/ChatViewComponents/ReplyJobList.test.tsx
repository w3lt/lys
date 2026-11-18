import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type {
  JobCardPresentation,
  ReplyJobsPresentation
} from "@/components/ChatViewComponents/job-presentation"
import ReplyJobList from "@/components/ChatViewComponents/ReplyJobList"
import {
  buildJob,
  buildJobCard,
  FIXTURE_JOB_ID
} from "../../support/conversationFixtures"

/** Card of job 1 while it works. */
const WORKING_CARD = buildJobCard(buildJob())

/** Card of job 1 once it was stopped. */
const STOPPED_CARD = buildJobCard(buildJob({ state: "stopped" }))

/**
 * Builds the jobs of a reply that started one job and continued none.
 *
 * @param card - Card of the started job.
 * @returns The reply's jobs.
 */
function buildStartedJobs(card: JobCardPresentation): ReplyJobsPresentation {
  return { started: [card], continued: [] }
}

/**
 * Renders the list of a reply that started one job, with callbacks that do
 * nothing.
 *
 * @param card - Card of the started job.
 * @returns The render result, whose `rerender` shows another card.
 */
function startJobList(card: JobCardPresentation) {
  return render(
    <ReplyJobList
      jobs={buildStartedJobs(card)}
      onOpenJob={vi.fn()}
      onStopJob={vi.fn()}
    />
  )
}

describe("ReplyJobList", () => {
  it("shows the agent, the title, the state, and the latest note", () => {
    startJobList(buildJobCard(buildJob({ latestNote: "Reading three feeds" })))

    const list = screen.getByRole("list", { name: "Jobs" })
    const card = within(list).getByRole("article")
    expect(card).toHaveAttribute("id", `job-${FIXTURE_JOB_ID}`)
    expect(
      within(card).getByRole("button", { name: "News, job 1" })
    ).toHaveTextContent("News")
    expect(within(card).getByText("Nyx")).toBeInTheDocument()
    expect(within(card).getByText("Working")).toBeInTheDocument()
    expect(within(card).getByText("Reading three feeds")).toBeInTheDocument()
  })

  it.each([
    ["working", WORKING_CARD, 1],
    ["needs-approval", buildJobCard(buildJob(), "needs-approval"), 1],
    ["replied", buildJobCard(buildJob({ state: "replied" })), 0]
  ] as const)(
    "offers Stop for a %s job only while the job works",
    (_label, card, stopButtonCount) => {
      startJobList(card)

      expect(
        screen.queryAllByRole("button", { name: "Stop job 1" })
      ).toHaveLength(stopButtonCount)
    }
  )

  it("asks the parent to open the job", async () => {
    const user = userEvent.setup()
    const onOpenJob = vi.fn()
    render(
      <ReplyJobList
        jobs={buildStartedJobs(WORKING_CARD)}
        onOpenJob={onOpenJob}
        onStopJob={vi.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: "News, job 1" }))

    expect(onOpenJob).toHaveBeenCalledTimes(1)
    expect(onOpenJob).toHaveBeenCalledWith(FIXTURE_JOB_ID)
  })

  it("asks the parent to stop the job", async () => {
    const user = userEvent.setup()
    const onOpenJob = vi.fn()
    const onStopJob = vi.fn()
    render(
      <ReplyJobList
        jobs={buildStartedJobs(WORKING_CARD)}
        onOpenJob={onOpenJob}
        onStopJob={onStopJob}
      />
    )

    await user.click(screen.getByRole("button", { name: "Stop job 1" }))

    expect(onStopJob).toHaveBeenCalledTimes(1)
    expect(onStopJob).toHaveBeenCalledWith(WORKING_CARD.job)
    expect(onOpenJob).not.toHaveBeenCalled()
  })

  it("links a continued job to its card", () => {
    render(
      <ReplyJobList
        jobs={{ started: [], continued: [WORKING_CARD] }}
        onOpenJob={vi.fn()}
        onStopJob={vi.fn()}
      />
    )

    expect(
      screen.getByRole("link", { name: "Continued job 1 with Nyx" })
    ).toHaveAttribute("href", `#job-${FIXTURE_JOB_ID}`)
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
  })

  it("keeps focus in the card when Stop leaves while it has focus", () => {
    const { rerender } = startJobList(WORKING_CARD)
    screen.getByRole("button", { name: "Stop job 1" }).focus()

    rerender(
      <ReplyJobList
        jobs={buildStartedJobs(STOPPED_CARD)}
        onOpenJob={vi.fn()}
        onStopJob={vi.fn()}
      />
    )

    expect(screen.getByRole("button", { name: "News, job 1" })).toHaveFocus()
  })

  it("takes no focus when Stop leaves while it has none", () => {
    const { rerender } = startJobList(WORKING_CARD)

    rerender(
      <ReplyJobList
        jobs={buildStartedJobs(STOPPED_CARD)}
        onOpenJob={vi.fn()}
        onStopJob={vi.fn()}
      />
    )

    expect(screen.queryByRole("button", { name: "Stop job 1" })).toBeNull()
    expect(document.body).toHaveFocus()
  })
})
