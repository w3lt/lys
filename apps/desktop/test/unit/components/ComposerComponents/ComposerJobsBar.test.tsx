import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef, type ReactElement, type RefObject } from "react"
import { describe, expect, it, vi } from "vitest"
import ComposerJobsBar from "@/components/ComposerComponents/ComposerJobsBar"

/** Hosts of the composer's controls that may take focus after Stop all. */
type SuccessorHosts = {
  /** Host of the message field. */
  readonly messageFieldRef: RefObject<HTMLTextAreaElement | null>
  /** Host of the New conversation button. */
  readonly newConversationButtonRef: RefObject<HTMLButtonElement | null>
}

/**
 * Builds a jobs bar before a message field and a New conversation button,
 * as the composer places them.
 *
 * @param workingJobCount - Number of jobs that work.
 * @param isFieldOff - Whether the message field is off.
 * @param hosts - Hosts of the field and of the button.
 * @returns The bar, whose stop request records nothing the case reads, the
 * field named `Message Caliginia`, and the button.
 */
function buildBarWithControls(
  workingJobCount: number,
  isFieldOff: boolean,
  hosts: SuccessorHosts
): ReactElement {
  return (
    <>
      <ComposerJobsBar
        messageFieldRef={hosts.messageFieldRef}
        newConversationButtonRef={hosts.newConversationButtonRef}
        onStopJobs={vi.fn()}
        workingJobCount={workingJobCount}
      />
      <textarea
        aria-label="Message Caliginia"
        disabled={isFieldOff}
        ref={hosts.messageFieldRef}
      />
      <button ref={hosts.newConversationButtonRef} type="button">
        New conversation
      </button>
    </>
  )
}

/**
 * Renders a bar for two working jobs before a message field and a New
 * conversation button.
 *
 * @param isFieldOff - Whether the message field is off.
 * @returns A call that ends both jobs, which removes Stop all, the message
 * field, and the New conversation button.
 */
function startWorkingBarWithControls(isFieldOff: boolean) {
  const hosts: SuccessorHosts = {
    messageFieldRef: createRef(),
    newConversationButtonRef: createRef()
  }
  const { rerender } = render(buildBarWithControls(2, isFieldOff, hosts))
  const field = screen.getByRole("textbox", { name: "Message Caliginia" })
  const newConversation = screen.getByRole("button", {
    name: "New conversation"
  })
  return {
    endJobs: () => rerender(buildBarWithControls(0, isFieldOff, hosts)),
    field,
    newConversation
  }
}

describe("ComposerJobsBar", () => {
  it("says how many jobs work and offers Stop all", async () => {
    const onStopJobs = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerJobsBar
        messageFieldRef={createRef()}
        newConversationButtonRef={createRef()}
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
        newConversationButtonRef={createRef()}
        onStopJobs={vi.fn()}
        workingJobCount={0}
      />
    )

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("moves focus to the message field when Stop all leaves while it has focus", () => {
    const { endJobs, field } = startWorkingBarWithControls(false)
    act(() => screen.getByRole("button", { name: "Stop all jobs" }).focus())

    endJobs()

    expect(field).toHaveFocus()
  })

  it("moves focus to New conversation when Stop all leaves with focus while the field is off", () => {
    const { endJobs, newConversation } = startWorkingBarWithControls(true)
    act(() => screen.getByRole("button", { name: "Stop all jobs" }).focus())

    endJobs()

    expect(newConversation).toHaveFocus()
  })

  it("moves no focus when Stop all leaves without it", () => {
    const { endJobs, field } = startWorkingBarWithControls(false)

    endJobs()

    expect(field).not.toHaveFocus()
    expect(document.body).toHaveFocus()
  })
})
