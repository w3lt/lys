import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import StartupSwitchRow from "@/components/SettingsViewComponents/StartupSwitchRow"

/** Heading and name of the switch the cases render. */
const LABEL = "Start it when Lys opens"

/** What off means for that switch. */
const DESCRIPTION = "Off means the first thing you do here is press start."

describe("StartupSwitchRow", () => {
  it("names the switch after its heading and describes it with what off means", () => {
    render(
      <StartupSwitchRow
        description={DESCRIPTION}
        isOn
        label={LABEL}
        onIsOnChange={vi.fn()}
      />
    )

    expect(screen.getByRole("heading", { name: LABEL })).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: LABEL })
    ).toHaveAccessibleDescription(DESCRIPTION)
  })

  it("shows a switch that is on and proposes off without turning itself off", async () => {
    const onIsOnChange = vi.fn()
    const user = userEvent.setup()
    render(
      <StartupSwitchRow
        description={DESCRIPTION}
        isOn
        label={LABEL}
        onIsOnChange={onIsOnChange}
      />
    )
    const toggle = screen.getByRole("switch", { name: LABEL })
    expect(screen.getByText("on")).toBeInTheDocument()

    await user.click(toggle)

    expect(onIsOnChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(toggle).toBeChecked()
    expect(screen.getByText("on")).toBeInTheDocument()
  })

  it("shows a switch that is off and proposes on without turning itself on", async () => {
    const onIsOnChange = vi.fn()
    const user = userEvent.setup()
    render(
      <StartupSwitchRow
        description={DESCRIPTION}
        isOn={false}
        label={LABEL}
        onIsOnChange={onIsOnChange}
      />
    )
    const toggle = screen.getByRole("switch", { name: LABEL })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText("off")).toBeInTheDocument()

    await user.click(toggle)

    expect(onIsOnChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(toggle).not.toBeChecked()
  })

  it("follows the parent when it accepts a proposal", () => {
    const { rerender } = render(
      <StartupSwitchRow
        description={DESCRIPTION}
        isOn={false}
        label={LABEL}
        onIsOnChange={vi.fn()}
      />
    )
    const toggle = screen.getByRole("switch", { name: LABEL })

    rerender(
      <StartupSwitchRow
        description={DESCRIPTION}
        isOn
        label={LABEL}
        onIsOnChange={vi.fn()}
      />
    )

    expect(toggle).toBeChecked()
    expect(screen.getByText("on")).toBeInTheDocument()
  })

  it("proposes a change from the keyboard", async () => {
    const onIsOnChange = vi.fn()
    const user = userEvent.setup()
    render(
      <StartupSwitchRow
        description={DESCRIPTION}
        isOn
        label={LABEL}
        onIsOnChange={onIsOnChange}
      />
    )

    await user.tab()
    await user.keyboard(" ")

    expect(screen.getByRole("switch", { name: LABEL })).toHaveFocus()
    expect(onIsOnChange).toHaveBeenCalledExactlyOnceWith(false)
  })
})
