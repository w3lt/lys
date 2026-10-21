import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ComposerAttachmentTray from "@/components/ComposerComponents/ComposerAttachmentTray"
import type { StagedAttachment } from "@/lib/store/chat-view/attachments"

/** Staged notes file. */
const NOTES: StagedAttachment = {
  id: "attachment-notes",
  draft: { kind: "text", name: "notes.md", sizeBytes: 3248 },
  content: btoa("# Notes")
}

/** Staged photo of 640 by 480 pixels, which estimates to 414 tokens. */
const PHOTO: StagedAttachment = {
  id: "attachment-photo",
  draft: {
    kind: "image",
    name: "photo.png",
    sizeBytes: 33,
    mediaType: "image/png",
    width: 640,
    height: 480
  },
  content: btoa("png")
}

describe("ComposerAttachmentTray", () => {
  it("lists the staged files in order with their kind, and an image's estimated tokens", () => {
    render(
      <ComposerAttachmentTray attachments={[NOTES, PHOTO]} onRemove={vi.fn()} />
    )

    const tray = screen.getByRole("list", { name: "Attached to this message" })
    expect(
      within(tray)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["mdnotes.md", "pngphoto.png~414"])
  })

  it("removes the file whose button is pressed, once", async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerAttachmentTray
        attachments={[NOTES, PHOTO]}
        onRemove={onRemove}
      />
    )

    await user.click(
      screen.getByRole("button", { name: "Remove photo.png from context" })
    )

    expect(onRemove).toHaveBeenCalledExactlyOnceWith("attachment-photo")
  })

  it("renders an empty list when given no files", () => {
    render(<ComposerAttachmentTray attachments={[]} onRemove={vi.fn()} />)

    expect(
      screen.getByRole("list", { name: "Attached to this message" })
    ).toBeEmptyDOMElement()
  })
})
