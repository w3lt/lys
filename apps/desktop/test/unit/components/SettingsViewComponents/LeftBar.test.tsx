import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import SettingsViewLeftBar, {
  type SettingsRailItem,
  type SettingsViewLeftBarProps
} from "@/components/SettingsViewComponents/LeftBar"

/** Rail entries in display order: one with sections, one with a marker. */
const ITEMS: readonly SettingsRailItem[] = [
  {
    value: "lys",
    label: "Lys",
    ordinal: "01",
    marker: null,
    sections: [
      { value: "about-lys", label: "About Lys", marker: null },
      {
        value: "lys-email",
        label: "Email",
        marker: { kind: "text", label: "Not set up" }
      }
    ]
  },
  {
    value: "mcp",
    label: "MCP",
    ordinal: "02",
    marker: { kind: "dot", tone: "danger", label: "1 server failed" },
    sections: []
  }
]

/**
 * Renders the rail with the entries above.
 *
 * @param props - Properties that differ from a rail showing the Lys pane.
 * @returns The proposals the rail can make.
 */
function renderRail(props: Partial<SettingsViewLeftBarProps> = {}) {
  const onPaneSelect = vi.fn<SettingsViewLeftBarProps["onPaneSelect"]>()
  const onSectionSelect = vi.fn<SettingsViewLeftBarProps["onSectionSelect"]>()
  render(
    <SettingsViewLeftBar
      items={ITEMS}
      onPaneSelect={onPaneSelect}
      onSectionSelect={onSectionSelect}
      selectedPane="lys"
      status="backend stopped"
      statusTone="neutral"
      {...props}
    />
  )
  return { onPaneSelect, onSectionSelect }
}

describe("SettingsViewLeftBar", () => {
  it("lists the panes in order with their ordinals, the shown one as the current page", () => {
    renderRail()

    const rail = screen.getByRole("navigation", { name: "Settings sections" })
    const sections = within(rail).getByRole("list", { name: "Lys sections" })
    const panes = within(rail)
      .getAllByRole("button")
      .filter((button) => !sections.contains(button))
    expect(
      panes.map((pane) => [pane.textContent, pane.getAttribute("aria-current")])
    ).toEqual([
      ["Lys01", "page"],
      ["MCP, 1 server failed02", null]
    ])
  })

  it("names a dot marker in words within its entry", () => {
    renderRail()

    expect(
      screen.getByRole("button", { name: /^MCP\s*, 1 server failed\s*02$/ })
    ).toBeInTheDocument()
  })

  it("lists the shown pane's sections with their markers, and no others", () => {
    renderRail()

    const sections = screen.getByRole("list", { name: "Lys sections" })
    expect(
      within(sections)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(["About Lys", "EmailNot set up"])
    expect(screen.queryByRole("list", { name: "MCP sections" })).toBeNull()
  })

  it("proposes the pane or the section the person chooses", async () => {
    const user = userEvent.setup()
    const { onPaneSelect, onSectionSelect } = renderRail()

    await user.click(screen.getByRole("button", { name: /^MCP/ }))
    await user.click(screen.getByRole("button", { name: /^Email/ }))

    expect(onPaneSelect).toHaveBeenCalledExactlyOnceWith("mcp")
    expect(onSectionSelect).toHaveBeenCalledExactlyOnceWith("lys-email")
  })

  it("shows the runtime summary at its foot", () => {
    renderRail({ status: "backend up · LM Studio not reachable" })

    expect(
      screen.getByRole("navigation", { name: "Settings sections" })
    ).toHaveTextContent("backend up · LM Studio not reachable")
  })
})
