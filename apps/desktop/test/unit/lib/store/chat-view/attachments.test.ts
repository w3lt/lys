import {
  MAXIMUM_ATTACHMENT_BYTES,
  MAXIMUM_MESSAGE_ATTACHMENT_BYTES
} from "@lys/share"
import { describe, expect, it } from "vitest"
import type { AttachmentModelSupport } from "@/lib/models/attachment-model-support"
import {
  parseAttachmentSelection,
  calculateStagedImageTokens,
  readAttachmentCandidate,
  addAttachmentCandidates,
  type AttachmentCandidate,
  type StagedAttachment
} from "@/lib/store/chat-view/attachments"
import {
  buildPngFile,
  buildTextFile,
  createPngBytes,
  buildAttachmentContent,
  UnreadableFile
} from "../../../support/attachmentFixtures"

/** A model that sees images and calls tools. */
const FULL_SUPPORT: AttachmentModelSupport = Object.freeze({
  vision: true,
  trainedForToolUse: true
})

/** Bytes in one mebibyte. */
const MEBIBYTE = 1024 * 1024

/** A read text file. */
const TEXT_CANDIDATE: AttachmentCandidate = {
  name: "notes.md",
  sizeBytes: 7,
  content: { kind: "text" },
  encoded: btoa("# Notes")
}

/** A read PNG image of 640 by 480 pixels. */
const IMAGE_CANDIDATE: AttachmentCandidate = {
  name: "photo.png",
  sizeBytes: 33,
  content: { kind: "image", mediaType: "image/png", width: 640, height: 480 },
  encoded: buildAttachmentContent(createPngBytes(640, 480))
}

/** A read file that is neither text nor an image. */
const UNSUPPORTED_CANDIDATE: AttachmentCandidate = {
  name: "archive.zip",
  sizeBytes: 4,
  content: { kind: "unsupported" },
  encoded: btoa("PK\u0003\u0004")
}

/**
 * Builds a staged text file.
 *
 * @param name - File name.
 * @param sizeBytes - Size the tray accounts; 8 when omitted.
 * @returns The staged file, with content that stands in for its bytes.
 */
function buildStagedText(name: string, sizeBytes = 8): StagedAttachment {
  return {
    id: `attachment-${name}`,
    draft: { kind: "text", name, sizeBytes },
    content: btoa("x")
  }
}

/**
 * Builds a staged PNG image.
 *
 * @param name - File name.
 * @param width - Width in pixels.
 * @param height - Height in pixels.
 * @returns The staged image.
 */
function buildStagedImage(
  name: string,
  width: number,
  height: number
): StagedAttachment {
  return {
    id: `attachment-${name}`,
    draft: {
      kind: "image",
      name,
      sizeBytes: 33,
      mediaType: "image/png",
      width,
      height
    },
    content: buildAttachmentContent(createPngBytes(width, height))
  }
}

/**
 * Builds a file of given size whose bytes are neither text nor an image.
 *
 * @param name - File name.
 * @param sizeBytes - Its size.
 * @returns The file.
 */
function buildBinaryFile(name: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name)
}

describe("readAttachmentCandidate", () => {
  it("reads a text file whole, classifies it, and encodes it", async () => {
    await expect(
      readAttachmentCandidate(buildTextFile("notes.md", "# Notes"))
    ).resolves.toEqual(TEXT_CANDIDATE)
  })

  it("reads an image's media type and sides from its bytes", async () => {
    await expect(
      readAttachmentCandidate(buildPngFile("photo.png", 640, 480))
    ).resolves.toEqual(IMAGE_CANDIDATE)
  })

  it("encodes a file longer than one encoding chunk", async () => {
    const content = "x".repeat(70_000)

    const candidate = await readAttachmentCandidate(
      buildTextFile("long.txt", content)
    )

    expect(candidate.encoded).toBe(btoa(content))
  })

  it("names the file that cannot be read and keeps the failure as the cause", async () => {
    const file = new UnreadableFile(["x"], "gone.txt")

    await expect(readAttachmentCandidate(file)).rejects.toMatchObject({
      message: "The file gone.txt could not be read",
      cause: file.failure
    })
  })
})

describe("parseAttachmentSelection", () => {
  it("admits files by name and size against the tray and the files before them, reporting the first refusal", () => {
    const admission = parseAttachmentSelection(
      [buildStagedText("notes.md")],
      [
        buildTextFile("Notes.MD", "again"),
        buildTextFile("table.csv", "a,b"),
        buildTextFile("TABLE.csv", "c,d")
      ]
    )

    expect(admission.admitted.map((file) => file.name)).toEqual(["table.csv"])
    expect(admission.refusal).toBe("The file Notes.MD is already uploaded")
  })

  it("treats a name as already uploaded when it differs only in accent composition", () => {
    const admission = parseAttachmentSelection(
      [buildStagedText("caf\u00e9.md")],
      [buildTextFile("cafe\u0301.md", "again")]
    )

    expect(admission).toEqual({
      admitted: [],
      refusal: "The file cafe\u0301.md is already uploaded"
    })
  })

  it.each<[string, readonly StagedAttachment[], File, string]>([
    [
      "a name Lys cannot store",
      [],
      buildTextFile("..", "x"),
      "The file .. has a name Lys cannot store"
    ],
    [
      "a name with a control character",
      [],
      buildTextFile("notes\u0007.md", "x"),
      "The file notes\u0007.md has a name Lys cannot store"
    ],
    [
      "a full tray",
      Array.from({ length: 8 }, (_, index) =>
        buildStagedText(`file-${index + 1}.txt`)
      ),
      buildTextFile("file-9.txt", "x"),
      "A message can carry at most 8 files"
    ],
    [
      "a file over the per-file limit",
      [],
      buildBinaryFile("big.bin", MAXIMUM_ATTACHMENT_BYTES + 1),
      "The file big.bin is larger than 10 MB"
    ],
    [
      "a file that would take the tray over the per-message limit",
      [buildStagedText("held.txt", 15 * MEBIBYTE)],
      buildBinaryFile(
        "more.bin",
        MAXIMUM_MESSAGE_ATTACHMENT_BYTES - 15 * MEBIBYTE + 1
      ),
      "A message's files can total at most 20 MB"
    ]
  ])("refuses %s", (_case, staged, file, refusal) => {
    expect(parseAttachmentSelection(staged, [file])).toEqual({
      admitted: [],
      refusal
    })
  })

  it("counts the files it admits, so the ninth file of one selection is refused", () => {
    const admission = parseAttachmentSelection(
      [],
      Array.from({ length: 9 }, (_, index) =>
        buildTextFile(`file-${index + 1}.txt`, "x")
      )
    )

    expect(admission.admitted.map((file) => file.name)).toEqual(
      Array.from({ length: 8 }, (_, index) => `file-${index + 1}.txt`)
    )
    expect(admission.refusal).toBe("A message can carry at most 8 files")
  })

  it("counts the bytes of the files it admits, so the file of one selection that would exceed the total is refused", () => {
    const admission = parseAttachmentSelection(
      [],
      [
        buildBinaryFile("one.bin", 7 * MEBIBYTE),
        buildBinaryFile("two.bin", 7 * MEBIBYTE),
        buildBinaryFile("three.bin", 7 * MEBIBYTE)
      ]
    )

    expect(admission.admitted.map((file) => file.name)).toEqual([
      "one.bin",
      "two.bin"
    ])
    expect(admission.refusal).toBe("A message's files can total at most 20 MB")
  })

  it("admits a file that fills the tray exactly", () => {
    const admission = parseAttachmentSelection(
      [buildStagedText("held.txt", MAXIMUM_MESSAGE_ATTACHMENT_BYTES - 10)],
      [buildBinaryFile("last.bin", 10)]
    )

    expect(admission).toMatchObject({ refusal: undefined })
    expect(admission.admitted.map((file) => file.name)).toEqual(["last.bin"])
  })

  it("refuses nothing from an empty selection", () => {
    expect(parseAttachmentSelection([buildStagedText("a.txt")], [])).toEqual({
      admitted: [],
      refusal: undefined
    })
  })
})

describe("addAttachmentCandidates", () => {
  it("stages the candidates after the tray in order, each with its own identity", () => {
    const staged = [buildStagedText("a.txt")]

    const staging = addAttachmentCandidates(
      staged,
      [TEXT_CANDIDATE, IMAGE_CANDIDATE],
      FULL_SUPPORT
    )

    expect(staging.refusal).toBeUndefined()
    expect(staging.attachments).toEqual([
      staged[0],
      {
        id: expect.stringMatching(/^attachment-/) as string,
        draft: { kind: "text", name: "notes.md", sizeBytes: 7 },
        content: TEXT_CANDIDATE.encoded
      },
      {
        id: expect.stringMatching(/^attachment-/) as string,
        draft: {
          kind: "image",
          name: "photo.png",
          sizeBytes: 33,
          mediaType: "image/png",
          width: 640,
          height: 480
        },
        content: IMAGE_CANDIDATE.encoded
      }
    ])
    expect(staging.attachments[1]?.id).not.toBe(staging.attachments[2]?.id)
  })

  it.each<[string, AttachmentCandidate, AttachmentModelSupport, string]>([
    [
      "content that is neither text nor an image",
      UNSUPPORTED_CANDIDATE,
      FULL_SUPPORT,
      "The file archive.zip is not a text file or an image Lys can send"
    ],
    [
      "an image for a model without vision",
      IMAGE_CANDIDATE,
      { vision: false, trainedForToolUse: true },
      "Images need a model with vision"
    ],
    [
      "a text file for a model not trained for tool use",
      TEXT_CANDIDATE,
      { vision: true, trainedForToolUse: false },
      "Files need a model trained for tool use"
    ]
  ])(
    "refuses %s and keeps the same tray",
    (_case, candidate, support, refusal) => {
      const staged = [buildStagedText("a.txt")]

      const staging = addAttachmentCandidates(staged, [candidate], support)

      expect(staging).toEqual({ attachments: staged, refusal })
      expect(staging.attachments).toBe(staged)
    }
  )

  it("stages the admitted candidates of a selection whose first is refused", () => {
    const staging = addAttachmentCandidates(
      [],
      [UNSUPPORTED_CANDIDATE, TEXT_CANDIDATE],
      FULL_SUPPORT
    )

    expect(staging.attachments.map(({ draft }) => draft.name)).toEqual([
      "notes.md"
    ])
    expect(staging.refusal).toBe(
      "The file archive.zip is not a text file or an image Lys can send"
    )
  })
})

describe("calculateStagedImageTokens", () => {
  it("sums the images' estimates and counts no text file", () => {
    expect(
      calculateStagedImageTokens([
        buildStagedText("a.txt", 100_000),
        buildStagedImage("photo.png", 640, 480),
        buildStagedImage("icon.png", 28, 28)
      ])
    ).toBe(23 * 18 + 1)
  })

  it("is zero for an empty tray", () => {
    expect(calculateStagedImageTokens([])).toBe(0)
  })

  it("counts a partial patch of an image as a whole token", () => {
    expect(
      calculateStagedImageTokens([buildStagedImage("icon.png", 29, 29)])
    ).toBe(4)
  })

  it("caps a large image's estimate", () => {
    expect(
      calculateStagedImageTokens([buildStagedImage("poster.png", 4000, 3000)])
    ).toBe(1280)
  })
})
