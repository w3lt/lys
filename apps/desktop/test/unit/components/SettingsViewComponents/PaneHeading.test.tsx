import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import PaneHeading from "@/components/SettingsViewComponents/PaneHeading"

describe("PaneHeading", () => {
  it("titles the pane with a level-one heading over its note", () => {
    render(<PaneHeading note="How far she wanders." title="Generation" />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Generation" })
    ).toBeInTheDocument()
    expect(screen.getByText("How far she wanders.")).toBeInTheDocument()
    expect(screen.queryByText("reading")).toBeNull()
  })

  it("shows a decorative reading marker while busy, outside the heading's name", () => {
    render(<PaneHeading busy note="Note." title="Model" />)

    expect(screen.getByText("reading")).toHaveAttribute("aria-hidden", "true")
    expect(
      screen.getByRole("heading", { level: 1, name: "Model" })
    ).toBeInTheDocument()
  })
})
