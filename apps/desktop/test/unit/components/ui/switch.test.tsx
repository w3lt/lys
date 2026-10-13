import { createRef, useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Switch } from "@/components/ui/switch"

/**
 * Plays a parent that accepts every proposed checked state.
 *
 * @returns A labelled switch the parent controls.
 */
function ControlledSwitch() {
  const [isChecked, setIsChecked] = useState(false)
  return (
    <Switch
      aria-label="Tool calls"
      checked={isChecked}
      onCheckedChange={setIsChecked}
    />
  )
}

describe("Switch", () => {
  it("is a named switch that forwards its description and ref", () => {
    const ref = createRef<HTMLElement>()
    render(
      <>
        <Switch
          aria-describedby="switch-note"
          aria-label="Tool calls"
          checked
          ref={ref}
        />
        <p id="switch-note">Two offered.</p>
      </>
    )

    const toolCalls = screen.getByRole("switch", { name: "Tool calls" })
    expect(toolCalls).toBeChecked()
    expect(toolCalls).toHaveAccessibleDescription("Two offered.")
    expect(ref.current).toBe(toolCalls)
  })

  it("proposes the opposite state by pointer and by Space, and shows what the parent accepts", async () => {
    const user = userEvent.setup()
    render(<ControlledSwitch />)
    const toolCalls = screen.getByRole("switch", { name: "Tool calls" })

    await user.click(toolCalls)
    expect(toolCalls).toBeChecked()

    await user.keyboard(" ")
    expect(toolCalls).not.toBeChecked()
  })

  it("keeps a controlled state the parent does not change", async () => {
    const onCheckedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <Switch
        aria-label="Tool calls"
        checked={false}
        onCheckedChange={onCheckedChange}
      />
    )

    await user.click(screen.getByRole("switch", { name: "Tool calls" }))

    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true)
    expect(screen.getByRole("switch", { name: "Tool calls" })).not.toBeChecked()
  })

  it("proposes nothing while disabled", async () => {
    const onCheckedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <Switch
        aria-label="Tool calls"
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
      />
    )

    await user.click(screen.getByRole("switch", { name: "Tool calls" }))

    expect(onCheckedChange).not.toHaveBeenCalled()
    expect(screen.getByRole("switch", { name: "Tool calls" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })
})
