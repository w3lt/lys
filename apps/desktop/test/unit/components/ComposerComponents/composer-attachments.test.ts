import { describe, expect, it } from "vitest"
import { formatAttachmentKind } from "@/components/ComposerComponents/composer-attachments"

describe("formatAttachmentKind", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpeg"],
    ["image/webp", "webp"]
  ] as const)(
    "marks an %s image as %s, whatever its name says",
    (mediaType, kind) => {
      expect(
        formatAttachmentKind({
          kind: "image",
          name: "picture.txt",
          sizeBytes: 33,
          mediaType,
          width: 64,
          height: 32
        })
      ).toBe(kind)
    }
  )

  it.each([
    ["notes.md", "md"],
    ["photo.JPEG", "jpeg"],
    ["archive.tar.gz", "gz"],
    ["table.parquet", "parq"],
    ["README", "txt"],
    [".bashrc", "txt"],
    ["draft.", "txt"]
  ])("marks the text file %s with the kind %s", (name, kind) => {
    expect(formatAttachmentKind({ kind: "text", name, sizeBytes: 10 })).toBe(
      kind
    )
  })
})
