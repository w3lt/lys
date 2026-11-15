import { lazy } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import SettingsPaneFrame from "@/components/SettingsViewComponents/SettingsPaneFrame"
import {
  SettingsSectionsContext,
  type SettingsSection,
  type SettingsSectionsContextValue
} from "@/components/SettingsViewComponents/SettingsSectionsContext"
import type { SettingsPaneDescriptor } from "@/views/SettingsView/SettingsView"

/**
 * Presents a stand-in pane body, as the injected content of the frame.
 *
 * @returns The body's text.
 */
function PaneBody() {
  return <p>Pane body</p>
}

/** Generation pane metadata with a stand-in body. */
const PANE: SettingsPaneDescriptor = {
  value: "generation",
  label: "Generation",
  ordinal: "03",
  note: "How far she wanders, and when she has to stop.",
  footNote: "Saved automatically for future messages.",
  layout: "sections",
  sections: [],
  contentComponent: lazy(() => Promise.resolve({ default: PaneBody }))
}

/** Profile pane metadata with two sections, a stand-in body, and no note. */
const SECTIONED_PANE: SettingsPaneDescriptor = {
  ...PANE,
  value: "profile",
  label: "Profile",
  footNote: null,
  layout: "panels",
  sections: [
    { value: "about-you", railLabel: "About you" },
    { value: "notes", railLabel: "Notes for Lys" }
  ]
}

/**
 * Renders the frame of the sectioned pane with some sections open.
 *
 * @param expandedSections - Sections that are open.
 * @returns The request that opens or closes sections.
 */
function renderSectionedFrame(expandedSections: readonly SettingsSection[]) {
  const onSectionsExpandedChange =
    vi.fn<SettingsSectionsContextValue["onSectionsExpandedChange"]>()
  const value: SettingsSectionsContextValue = {
    expandedSections: new Set(expandedSections),
    focusedSection: null,
    onSectionsExpandedChange,
    onSectionFocused: vi.fn()
  }
  render(
    <SettingsSectionsContext value={value}>
      <SettingsPaneFrame onDone={vi.fn()} pane={SECTIONED_PANE} />
    </SettingsSectionsContext>
  )
  return onSectionsExpandedChange
}

describe("SettingsPaneFrame", () => {
  it("frames the ready body with the heading, Done, and the closing note", async () => {
    render(<SettingsPaneFrame onDone={vi.fn()} pane={PANE} />)

    expect(await screen.findByText("Pane body")).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { level: 1, name: "Generation" })
    ).toBeInTheDocument()
    expect(
      screen.getByText("Saved automatically for future messages.")
    ).toBeInTheDocument()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("keeps the heading and Done while busy, with the placeholder instead of the body and note", () => {
    render(<SettingsPaneFrame busy onDone={vi.fn()} pane={PANE} />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Generation" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading generation settings"
    )
    expect(screen.queryByText("Pane body")).toBeNull()
    expect(
      screen.queryByText("Saved automatically for future messages.")
    ).toBeNull()
  })

  it("leaves settings once per press of Done", async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<SettingsPaneFrame busy onDone={onDone} pane={PANE} />)

    await user.click(screen.getByRole("button", { name: "Done" }))

    expect(onDone).toHaveBeenCalledOnce()
  })

  it("closes every section of the pane while one is open", async () => {
    const user = userEvent.setup()
    const onSectionsExpandedChange = renderSectionedFrame(["notes"])

    await user.click(
      await screen.findByRole("button", { name: "Collapse all" })
    )

    expect(onSectionsExpandedChange).toHaveBeenCalledExactlyOnceWith(
      ["about-you", "notes"],
      false
    )
  })

  it("opens every section of the pane while all are closed", async () => {
    const user = userEvent.setup()
    const onSectionsExpandedChange = renderSectionedFrame([])

    await user.click(await screen.findByRole("button", { name: "Expand all" }))

    expect(onSectionsExpandedChange).toHaveBeenCalledExactlyOnceWith(
      ["about-you", "notes"],
      true
    )
  })

  it("shows no closing note for a pane without one", async () => {
    renderSectionedFrame([])

    expect(await screen.findByText("Pane body")).toBeInTheDocument()
    expect(screen.queryByRole("contentinfo")).toBeNull()
    expect(
      screen.queryByText("Saved automatically for future messages.")
    ).toBeNull()
  })
})
