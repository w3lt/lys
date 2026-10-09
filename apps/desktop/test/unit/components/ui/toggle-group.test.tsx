import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

/**
 * Plays a parent that owns the pressed value and accepts every proposal.
 *
 * @param props - Whether the group is disabled.
 * @returns A labelled single-choice group of three numbers.
 */
function ControlledGroup({
  disabled = false
}: {
  readonly disabled?: boolean
}) {
  const [value, setValue] = useState<string[]>(["8"])
  return (
    <ToggleGroup
      aria-label="Calls per reply"
      disabled={disabled}
      onValueChange={setValue}
      value={value}
    >
      {["4", "8", "16"].map((option) => (
        <ToggleGroupItem key={option} value={option}>
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/**
 * Lists the pressed state of each choice.
 *
 * @returns `aria-pressed` of every choice, in order.
 */
function listPressedStates(): (string | null)[] {
  return within(screen.getByRole("group", { name: "Calls per reply" }))
    .getAllByRole("button")
    .map((choice) => choice.getAttribute("aria-pressed"))
}

describe("ToggleGroup", () => {
  it("is a named group of toggle buttons pressed by the parent's value", () => {
    render(<ControlledGroup />)

    expect(listPressedStates()).toEqual(["false", "true", "false"])
  })

  it("proposes the pressed choice as the new value", async () => {
    const user = userEvent.setup()
    render(<ControlledGroup />)

    await user.click(screen.getByRole("button", { name: "16" }))

    expect(listPressedStates()).toEqual(["false", "false", "true"])
  })

  it("moves focus between choices with the arrow keys", async () => {
    const user = userEvent.setup()
    render(<ControlledGroup />)
    screen.getByRole("button", { name: "8" }).focus()

    await user.keyboard("{ArrowRight}")

    expect(screen.getByRole("button", { name: "16" })).toHaveFocus()
  })

  it("proposes nothing while disabled", async () => {
    const onValueChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ToggleGroup
        aria-label="Calls per reply"
        disabled
        onValueChange={onValueChange}
        value={["8"]}
      >
        <ToggleGroupItem value="4">4</ToggleGroupItem>
        <ToggleGroupItem value="8">8</ToggleGroupItem>
      </ToggleGroup>
    )

    await user.click(screen.getByRole("button", { name: "4" }))

    expect(onValueChange).not.toHaveBeenCalled()
  })
})
