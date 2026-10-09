import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import SettingsViewLeftBar, {
  type SettingsRailItem
} from "@/components/SettingsViewComponents/LeftBar"
import { Tabs } from "@/components/ui/tabs"

/** Rail entries in display order. */
const ITEMS: readonly SettingsRailItem[] = [
  { value: "runtime", label: "Runtime", ordinal: "01" },
  { value: "model", label: "Model", ordinal: "02" }
]

describe("SettingsViewLeftBar", () => {
  it("lists the panes as tabs in order, with their ordinals, under the selected pane", () => {
    render(
      <Tabs orientation="vertical" value="model">
        <SettingsViewLeftBar items={ITEMS} status="backend stopped" />
      </Tabs>
    )

    const rail = screen.getByRole("tablist", { name: "Settings sections" })
    expect(rail).toHaveAttribute("aria-orientation", "vertical")
    expect(
      screen
        .getAllByRole("tab")
        .map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])
    ).toEqual([
      ["Runtime01", "false"],
      ["Model02", "true"]
    ])
  })

  it("shows the runtime summary at its foot", () => {
    render(
      <Tabs value="runtime">
        <SettingsViewLeftBar
          items={ITEMS}
          status="backend up · LM Studio not reachable"
        />
      </Tabs>
    )

    expect(
      screen.getByRole("tablist", { name: "Settings sections" })
    ).toHaveTextContent("backend up · LM Studio not reachable")
  })

  it("marks the pane being read without changing its accessible name", () => {
    render(
      <Tabs value="runtime">
        <SettingsViewLeftBar items={ITEMS} loadingPane="model" status="" />
      </Tabs>
    )

    expect(
      screen.getByRole("tab", { name: /^Model\s*02$/ })
    ).toBeInTheDocument()
  })
})
