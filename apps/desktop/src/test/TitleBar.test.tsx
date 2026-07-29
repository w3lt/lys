import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { TitleBar } from "../components/TitleBar"

function ControlledTitleBar() {

  return (
    <>
      <TitleBar />
      <button type="button">Outside target</button>
    </>
  )
}

async function waitForMenu() {
  await new Promise((resolve) => window.setTimeout(resolve, 50))
  return screen.findByRole("menu")
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.classList.add("dark")
})

describe("TitleBar", () => {
  it("opens the scenario menu and selects a scenario", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onScenarioSelect = vi.fn()
    const { rerender } = render(
      <TitleBar />
    )

    await user.click(screen.getByRole("button", { name: "Reference states" }))
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(true)
    expect(onOpenChange).toHaveBeenCalledTimes(1)

    rerender(
      <TitleBar />
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

  it("aligns the rendered actions at the title bar edge", () => {
    const { container } = render(<ControlledTitleBar />)

    const actions = container.querySelector(".title-bar__actions")
    const actionsStyle = window.getComputedStyle(actions as Element)

    expect(actionsStyle.justifySelf).toBe("end")
    expect(actionsStyle.marginRight).toBe("8px")
  })

  it("names the theme control after the appearance it switches to", () => {
    render(<ControlledTitleBar />)

    expect(
      screen.getByRole("button", { name: "Switch to light theme" })
    ).toBeInTheDocument()
    expect(document.documentElement).toHaveClass("dark")
  })

  it("switches the appearance and remembers the choice", async () => {
    const user = userEvent.setup()
    render(<ControlledTitleBar />)

    await user.click(
      screen.getByRole("button", { name: "Switch to light theme" })
    )

    expect(document.documentElement).not.toHaveClass("dark")
    expect(window.localStorage.getItem("lys.theme")).toBe("light")
    expect(
      screen.getByRole("button", { name: "Switch to dark theme" })
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Switch to dark theme" })
    )

    expect(document.documentElement).toHaveClass("dark")
    expect(window.localStorage.getItem("lys.theme")).toBe("dark")
  })

  it("restores a stored light appearance on mount", () => {
    window.localStorage.setItem("lys.theme", "light")

    render(<ControlledTitleBar />)

    expect(document.documentElement).not.toHaveClass("dark")
    expect(
      screen.getByRole("button", { name: "Switch to dark theme" })
    ).toBeInTheDocument()
  })
})
