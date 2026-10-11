import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { Tooltip } from "@/components/ui/tooltip"
import { startHover, stopHover } from "../../support/rendering"

/** Hover time after which the description opens, in milliseconds. */
const OPEN_DELAY_MS = 600

/**
 * Puts the case's timers under a fake clock until the case finishes, so the
 * hover delay passes only when the case advances it.
 */
function startFakeTimers(): void {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
}

/**
 * Advances the fake clock inside a React update scope.
 *
 * @param milliseconds - Time to advance.
 */
function updateFakeClock(milliseconds: number): void {
  act(() => {
    vi.advanceTimersByTime(milliseconds)
  })
}

/**
 * Renders a disabled button described by a tooltip, beside another button.
 *
 * @returns The element the pointer rests on: the trigger wrapper, because
 * a disabled control receives no pointer events.
 */
function startTooltip(): HTMLElement {
  render(
    <>
      <Tooltip description="LM Studio is not reachable.">
        <button disabled type="button">
          Refresh
        </button>
      </Tooltip>
      <button type="button">Elsewhere</button>
    </>
  )
  const wrapper = screen.getByRole("button", { name: "Refresh" }).parentElement
  if (wrapper === null) throw new Error("The tooltip has no trigger")
  return wrapper
}

describe("Tooltip", () => {
  it("shows its description only after the pointer has rested on the trigger for 600 ms", () => {
    startFakeTimers()
    const trigger = startTooltip()

    startHover(trigger)
    updateFakeClock(OPEN_DELAY_MS - 1)
    const beforeDelay = screen.queryByText("LM Studio is not reachable.")
    updateFakeClock(1)

    expect(beforeDelay).toBeNull()
    expect(screen.getByText("LM Studio is not reachable.")).toBeInTheDocument()
  })

  it("closes when the pointer leaves the trigger", () => {
    startFakeTimers()
    const trigger = startTooltip()
    startHover(trigger)
    updateFakeClock(OPEN_DELAY_MS)
    screen.getByText("LM Studio is not reachable.")

    stopHover(trigger)
    updateFakeClock(0)

    expect(screen.queryByText("LM Studio is not reachable.")).toBeNull()
  })

  it("adds no focus stop of its own", async () => {
    const user = userEvent.setup()
    startTooltip()

    await user.tab()

    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus()
  })
})
