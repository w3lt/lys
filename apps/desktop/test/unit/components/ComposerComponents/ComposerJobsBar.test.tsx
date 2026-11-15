import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef, type ReactElement, type RefObject } from "react"
import { describe, expect, it, vi } from "vitest"
import ComposerJobsBar from "@/components/ComposerComponents/ComposerJobsBar"

/**
 * Builds a jobs bar beside a message field, as the composer places them.
 *
 * @param workingJobCount - Number of jobs that work.
 * @param messageFieldRef - Host of the message field.
 * @returns The bar, whose stop request records nothing the case reads, and
 * the field named `Message Caliginia`.
 */
function buildBarWithField(
  workingJobCount: number,
  messageFieldRef: RefObject<HTMLTextAreaElement | null>
): ReactElement {
  return (
    <>
      <ComposerJobsBar
        messageFieldRef={messageFieldRef}
        onStopJobs={vi.fn()}
        workingJobCount={workingJobCount}
      />
      <textarea aria-label="Message Caliginia" ref={messageFieldRef} />
    </>
  )
}

/**
 * Renders a bar for two working jobs beside a message field.
 *
 * @returns A call that ends both jobs, which removes Stop all, and the
 * message field.
 */
function startWorkingBarWithField() {
  const messageFieldRef = createRef<HTMLTextAreaElement>()
  const { rerender } = render(buildBarWithField(2, messageFieldRef))
  return {
    endJobs: () => rerender(buildBarWithField(0, messageFieldRef)),
    field: screen.getByRole("textbox", { name: "Message Caliginia" })
  }
}

describe("ComposerJobsBar", () => {
  it("says how many jobs work and offers Stop all", async () => {
    const onStopJobs = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerJobsBar
        messageFieldRef={createRef()}
        onStopJobs={onStopJobs}
        workingJobCount={3}
      />
    )
    const stopAll = screen.getByRole("button", { name: "Stop all jobs" })

    await user.click(stopAll)

    expect(screen.getByRole("status")).toHaveTextContent("3 jobs are working")
    expect(stopAll).toHaveTextContent("Stop all")
    expect(onStopJobs).toHaveBeenCalledTimes(1)
  })

  it("says nothing while no job works", () => {
    render(
      <ComposerJobsBar
        messageFieldRef={createRef()}
        onStopJobs={vi.fn()}
        workingJobCount={0}
      />
    )

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("moves focus to the message field when Stop all leaves while it has focus", () => {
    const { endJobs, field } = startWorkingBarWithField()
    act(() => screen.getByRole("button", { name: "Stop all jobs" }).focus())

    endJobs()

    expect(field).toHaveFocus()
  })

  it("moves no focus when Stop all leaves without it", () => {
    const { endJobs, field } = startWorkingBarWithField()

    endJobs()

    expect(field).not.toHaveFocus()
    expect(document.body).toHaveFocus()
  })
})
