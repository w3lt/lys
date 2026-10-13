import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

/**
 * Plays a parent that owns the selected tab and accepts every proposal.
 *
 * @returns Two vertical tabs with their panels.
 */
function ControlledTabs() {
  const [value, setValue] = useState("runtime")
  return (
    <Tabs
      onValueChange={(next) => setValue(String(next))}
      orientation="vertical"
      value={value}
    >
      <TabsList aria-label="Settings sections">
        <TabsTrigger value="runtime">Runtime</TabsTrigger>
        <TabsTrigger value="model">Model</TabsTrigger>
      </TabsList>
      <TabsContent value="runtime">Runtime pane</TabsContent>
      <TabsContent value="model">Model pane</TabsContent>
    </Tabs>
  )
}

describe("Tabs", () => {
  it("relates each tab to its panel and shows only the selected panel", () => {
    render(<ControlledTabs />)

    const runtime = screen.getByRole("tab", { name: "Runtime" })
    expect(runtime).toHaveAttribute("aria-selected", "true")
    const panel = screen.getByRole("tabpanel", { name: "Runtime" })
    expect(panel).toHaveTextContent("Runtime pane")
    expect(runtime).toHaveAttribute("aria-controls", panel.id)
    expect(screen.queryByText("Model pane")).toBeNull()
  })

  it("lays its list out in the root's orientation", () => {
    render(<ControlledTabs />)

    expect(
      screen.getByRole("tablist", { name: "Settings sections" })
    ).toHaveAttribute("aria-orientation", "vertical")
  })

  it("selects a tab by pointer", async () => {
    const user = userEvent.setup()
    render(<ControlledTabs />)

    await user.click(screen.getByRole("tab", { name: "Model" }))

    expect(screen.getByRole("tab", { name: "Model" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Model pane")
  })

  it("moves between tabs with the arrow keys of its orientation and selects with Enter", async () => {
    const user = userEvent.setup()
    render(<ControlledTabs />)
    screen.getByRole("tab", { name: "Runtime" }).focus()

    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("tab", { name: "Model" })).toHaveFocus()

    await user.keyboard("{Enter}")
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Model pane")
  })
})
