import { lazy } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import SettingsPaneFrame from "@/components/SettingsViewComponents/SettingsPaneFrame"
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
  contentComponent: lazy(() => Promise.resolve({ default: PaneBody }))
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
})
