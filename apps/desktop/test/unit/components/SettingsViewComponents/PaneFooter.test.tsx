import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import PaneFooter from "@/components/SettingsViewComponents/PaneFooter"

describe("PaneFooter", () => {
  it("closes the pane with its note", () => {
    render(<PaneFooter note="Saved automatically for future messages." />)

    expect(
      screen.getByText("Saved automatically for future messages.")
    ).toBeInTheDocument()
  })
})
