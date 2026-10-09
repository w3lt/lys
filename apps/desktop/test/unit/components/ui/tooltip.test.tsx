import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { Tooltip } from "@/components/ui/tooltip"
import { waitForMicrotasks } from "../../support/settlement"

/**
 * Renders a disabled button described by a tooltip, beside another button.
 *
 * @returns The element the pointer rests on: the trigger wrapper, because
 * a disabled control receives no pointer events.
 */
function renderTooltip(): HTMLElement {
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
  it("shows its description only after the pointer has rested on the trigger", async () => {
    const user = userEvent.setup()
    const trigger = renderTooltip()

    await user.hover(trigger)
    expect(screen.queryByText("LM Studio is not reachable.")).toBeNull()

    expect(
      await screen.findByText("LM Studio is not reachable.")
    ).toBeInTheDocument()
  })

  it("closes when the pointer leaves the trigger", async () => {
    const user = userEvent.setup()
    const trigger = renderTooltip()
    await user.hover(trigger)
    await screen.findByText("LM Studio is not reachable.")

    await user.unhover(trigger)
    await act(async () => {
      await waitForMicrotasks()
    })

    expect(screen.queryByText("LM Studio is not reachable.")).toBeNull()
  })

  it("adds no focus stop of its own", async () => {
    const user = userEvent.setup()
    renderTooltip()

    await user.tab()

    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus()
  })
})
