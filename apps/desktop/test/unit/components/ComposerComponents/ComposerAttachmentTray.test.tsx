import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ComposerAttachmentTray from "@/components/ComposerComponents/ComposerAttachmentTray"
import type { ComposerAttachment } from "@/components/ComposerComponents/composer-context"

/** Staged notes file. */
const NOTES: ComposerAttachment = {
  id: "attachment-notes",
  name: "notes.md",
  kind: "md",
  estimatedTokens: 812
}

/** Staged large export. */
const EXPORT: ComposerAttachment = {
  id: "attachment-export",
  name: "export.csv",
  kind: "csv",
  estimatedTokens: 12_400
}

describe("ComposerAttachmentTray", () => {
  it("lists the staged files in order with their kind and estimated tokens", () => {
    render(
      <ComposerAttachmentTray
        attachments={[NOTES, EXPORT]}
        onRemove={vi.fn()}
      />
    )

    const tray = screen.getByRole("list", { name: "Attached to this message" })
    expect(
      within(tray)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["mdnotes.md~812", "csvexport.csv~12k"])
  })

  it("removes the file whose button is pressed, once", async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerAttachmentTray
        attachments={[NOTES, EXPORT]}
        onRemove={onRemove}
      />
    )

    await user.click(
      screen.getByRole("button", { name: "Remove export.csv from context" })
    )

    expect(onRemove).toHaveBeenCalledExactlyOnceWith("attachment-export")
  })

  it("names the file blamed for an overflowing window in its remove button", () => {
    render(
      <ComposerAttachmentTray
        attachments={[NOTES, EXPORT]}
        onRemove={vi.fn()}
        overflowingAttachmentId="attachment-export"
      />
    )

    expect(
      screen.getByRole("button", {
        name: "Remove export.csv from context; it does not fit the window"
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Remove notes.md from context" })
    ).toBeInTheDocument()
  })

  it("renders an empty list when given no files", () => {
    render(<ComposerAttachmentTray attachments={[]} onRemove={vi.fn()} />)

    expect(
      screen.getByRole("list", { name: "Attached to this message" })
    ).toBeEmptyDOMElement()
  })
})
