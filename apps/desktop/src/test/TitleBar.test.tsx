import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { ScenarioKey } from "@/app/types"

import { TitleBar } from "../components/TitleBar"

function ControlledTitleBar({
  onScenarioSelect = vi.fn(),
}: {
  onScenarioSelect?: (key: ScenarioKey) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <TitleBar
        open={open}
        onOpenChange={setOpen}
        onScenarioSelect={onScenarioSelect}
      />
      <button type="button">Outside target</button>
    </>
  )
}

async function waitForMenu() {
  await new Promise((resolve) => window.setTimeout(resolve, 50))
  return screen.findByRole("menu")
}

describe("TitleBar", () => {
  it("opens the scenario menu and selects a scenario", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onScenarioSelect = vi.fn()
    const { rerender } = render(
      <TitleBar
        open={false}
        onOpenChange={onOpenChange}
        onScenarioSelect={onScenarioSelect}
      />
    )

    await user.click(screen.getByRole("button", { name: "Reference states" }))
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(true)
    expect(onOpenChange).toHaveBeenCalledTimes(1)

    rerender(
      <TitleBar
        open
        onOpenChange={onOpenChange}
        onScenarioSelect={onScenarioSelect}
      />
    )
    await user.click(screen.getByRole("menuitem", { name: /Inline error/ }))

    expect(onScenarioSelect).toHaveBeenCalledWith("error")
  })

  it("opens the real menu from the keyboard", async () => {
    const user = userEvent.setup()
    render(<ControlledTitleBar />)
    const trigger = screen.getByRole("button", { name: "Reference states" })

    trigger.focus()
    await user.keyboard("{Enter}")

    expect(await waitForMenu()).toBeInTheDocument()
    expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  it("dismisses the real menu with Escape", async () => {
    const user = userEvent.setup()
    render(<ControlledTitleBar />)

    await user.click(screen.getByRole("button", { name: "Reference states" }))
    await waitForMenu()
    await user.keyboard("{Escape}")

    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    )
  })

  it("dismisses the real menu when clicking outside", async () => {
    const user = userEvent.setup()
    render(<ControlledTitleBar />)

    await user.click(screen.getByRole("button", { name: "Reference states" }))
    await waitForMenu()
    await user.click(screen.getByRole("button", { name: "Outside target" }))

    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    )
  })

  it("aligns the rendered trigger at the title bar edge", () => {
    render(<ControlledTitleBar />)

    const triggerStyle = window.getComputedStyle(
      screen.getByRole("button", { name: "Reference states" })
    )

    expect(triggerStyle.justifySelf).toBe("end")
    expect(triggerStyle.marginRight).toBe("12px")
  })
})
