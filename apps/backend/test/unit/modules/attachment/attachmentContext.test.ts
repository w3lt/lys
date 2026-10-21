import { describe, expect, it } from "vitest"
import {
  buildUserMessageText,
  formatAttachmentLabel,
  formatByteCount,
  formatMissingImagePlaceholder,
  formatUnseenImagePlaceholder
} from "../../../../src/modules/attachment/attachmentContext"
import {
  createImageAttachment,
  createTextAttachment
} from "../../support/attachmentFixtures"

/** A stored PNG attachment that must be a `ConversationImageAttachment`. */
const PHOTO = createImageAttachment(2, "photo.png", { width: 640, height: 480 })

describe("formatAttachmentLabel", () => {
  it("names an attachment by its number and name", () => {
    expect(formatAttachmentLabel(createTextAttachment(3, "notes.md"))).toBe(
      "[attachment 3] notes.md"
    )
  })
})

describe("formatByteCount", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 bytes"],
    [999, "999 bytes"],
    [1_234_567, "1,234,567 bytes"]
  ])("formats %i with thousands separators", (byteCount, expected) => {
    expect(formatByteCount(byteCount)).toBe(expected)
  })
})

describe("image placeholders", () => {
  it("says an image's file is missing from this machine", () => {
    if (PHOTO.kind !== "image") throw new Error("Expected an image")

    expect(formatMissingImagePlaceholder(PHOTO)).toBe(
      "[attachment 2] photo.png is an image whose file is missing from this machine, so it cannot be shown."
    )
  })

  it("says the model cannot see an image", () => {
    if (PHOTO.kind !== "image") throw new Error("Expected an image")

    expect(formatUnseenImagePlaceholder(PHOTO)).toBe(
      "[attachment 2] photo.png is an image that this model cannot see."
    )
  })
})

describe("buildUserMessageText", () => {
  it("returns the text alone for a message without attachments", () => {
    expect(buildUserMessageText("Hello", [], [])).toBe("Hello")
  })

  it("lists each attachment with its kind and size after a blank line, then the placeholders", () => {
    expect(
      buildUserMessageText(
        "Look at these",
        [createTextAttachment(1, "notes.md", 1234), PHOTO],
        ["[attachment 2] photo.png is an image that this model cannot see."]
      )
    ).toBe(
      [
        "Look at these",
        "",
        "Attached files:",
        "[attachment 1] notes.md (text, 1,234 bytes)",
        "[attachment 2] photo.png (image/png, 640×480, 33 bytes)",
        "[attachment 2] photo.png is an image that this model cannot see."
      ].join("\n")
    )
  })
})
