import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import SettingsPanelSection from "@/components/SettingsViewComponents/SettingsPanelSection"
import {
  SettingsSectionsContext,
  type SettingsSection,
  type SettingsSectionsContextValue
} from "@/components/SettingsViewComponents/SettingsSectionsContext"

/**
 * Renders the Notes section with a switch in its header and a body.
 *
 * @param state - Whether the section is open, and whether the rail asked
 * for its button to take focus.
 * @returns The requests the section makes.
 */
function renderNotesSection(state: {
  readonly isExpanded: boolean
  readonly focusedSection: SettingsSection | null
}) {
  const value: SettingsSectionsContextValue = {
    expandedSections: new Set<SettingsSection>(
      state.isExpanded ? ["notes"] : []
    ),
    focusedSection: state.focusedSection,
    onSectionsExpandedChange: vi.fn(),
    onSectionFocused: vi.fn()
  }
  render(
    <SettingsSectionsContext value={value}>
      <SettingsPanelSection
        aside={<button type="button">Header control</button>}
        description="What to keep in mind"
        eyebrow="Profile"
        leading={null}
        section="notes"
        summary="No notes yet · sent with every request"
        title="Notes for Lys"
      >
        <p>Section body</p>
      </SettingsPanelSection>
    </SettingsSectionsContext>
  )
  return value
}

/** Renders the Notes section without the settings view around it. */
function renderNotesSectionAlone(): void {
  render(
    <SettingsPanelSection
      aside={null}
      description={null}
      eyebrow={null}
      leading={null}
      section="notes"
      summary=""
      title="Notes for Lys"
    >
      <p>Section body</p>
    </SettingsPanelSection>
  )
}

describe("SettingsPanelSection", () => {
  it("names its disclosure button in a heading, and shows the body it controls while open", () => {
    renderNotesSection({ isExpanded: true, focusedSection: null })

    const button = screen.getByRole("button", { name: /Notes for Lys/ })
    expect(screen.getByRole("heading", { level: 2 })).toContainElement(button)
    expect(button).toHaveAttribute("aria-expanded", "true")
    expect(button).toHaveTextContent("ProfileNotes for LysWhat to keep in mind")
    const bodyId = button.getAttribute("aria-controls") ?? ""
    expect(document.getElementById(bodyId)).toContainElement(
      screen.getByText("Section body")
    )
    expect(
      screen.getByRole("button", { name: "Header control" })
    ).toBeInTheDocument()
  })

  it("shows its summary instead of the body while closed", () => {
    renderNotesSection({ isExpanded: false, focusedSection: null })

    const button = screen.getByRole("button", { name: /Notes for Lys/ })
    expect(button).toHaveAttribute("aria-expanded", "false")
    expect(button).not.toHaveAttribute("aria-controls")
    expect(button).toHaveTextContent("No notes yet · sent with every request")
    expect(screen.queryByText("Section body")).toBeNull()
  })

  it("proposes opening or closing itself", async () => {
    const value = renderNotesSection({
      isExpanded: false,
      focusedSection: null
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: /Notes for Lys/ }))

    expect(value.onSectionsExpandedChange).toHaveBeenCalledExactlyOnceWith(
      ["notes"],
      true
    )
  })

  it("takes focus when the rail jumped to it, and reports it", () => {
    const value = renderNotesSection({
      isExpanded: true,
      focusedSection: "notes"
    })

    expect(screen.getByRole("button", { name: /Notes for Lys/ })).toHaveFocus()
    expect(value.onSectionFocused).toHaveBeenCalledOnce()
  })

  it("fails at once outside the settings view", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    expect(renderNotesSectionAlone).toThrow(
      "A settings section must be rendered in the settings view."
    )
  })
})
