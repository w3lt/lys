import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import SettingsChoiceGroup, {
  type SettingsChoice
} from "@/components/SettingsViewComponents/SettingsChoiceGroup"

/** Units a preference chooses between. */
type Units = "metric" | "imperial"

/** The two units, in order. */
const UNITS: readonly SettingsChoice<Units>[] = [
  { value: "metric", label: "Metric" },
  { value: "imperial", label: "Imperial" }
]

/**
 * Renders the group named by a visible label, with metric chosen.
 *
 * @param disabled - Whether every choice is disabled.
 * @returns The proposal spy.
 */
function renderUnits(disabled = false) {
  const onValueChange = vi.fn<(value: Units) => void>()
  render(
    <>
      <span id="units-label">Units</span>
      <SettingsChoiceGroup
        choices={UNITS}
        disabled={disabled}
        labelId="units-label"
        onValueChange={onValueChange}
        value="metric"
      />
    </>
  )
  return onValueChange
}

describe("SettingsChoiceGroup", () => {
  it("is a group named by its label, with the chosen button pressed", () => {
    renderUnits()

    expect(screen.getByRole("group", { name: "Units" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Metric" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(screen.getByRole("button", { name: "Imperial" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("proposes the pressed choice, and nothing when the chosen one is pressed again", async () => {
    const onValueChange = renderUnits()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Metric" }))
    await user.click(screen.getByRole("button", { name: "Imperial" }))

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("imperial")
  })

  it("proposes nothing while disabled", async () => {
    const onValueChange = renderUnits(true)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Imperial" }))

    expect(onValueChange).not.toHaveBeenCalled()
  })
})
