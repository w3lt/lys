import { describe, expect, it } from "vitest"
import { parseChatAttachments } from "../../../../src/modules/attachment/chatAttachments"
import {
  buildAttachmentContent,
  createExtendedWebpBytes,
  createJpegBytes,
  createLosslessWebpBytes,
  createLossyWebpBytes,
  createPngBytes
} from "../../support/attachmentFixtures"

/** UTF-8 bytes of a small notes file, as the parser hands them on. */
const NOTES_TEXT = Buffer.from("Buy milk\nCall mum\n")

/** Bytes that are neither text nor an image Lys sends: a GIF header. */
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00])

/** Start of image, then a progressive frame header (SOF2) of 300 by 200. */
const PROGRESSIVE_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x01
])

/**
 * Start of image, a fill byte, a standalone restart marker, then a baseline
 * frame header of 64 by 32.
 */
const PADDED_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xff, 0xd0, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00,
  0x40, 0x01
])

/** Start of image, then the start of scan before any frame header. */
const SCAN_FIRST_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20,
  0x00, 0x40, 0x01
])

/** Start of image, then an application segment the bytes end within. */
const TRUNCATED_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10
])

/** Start of image, then a byte where a marker should be. */
const BROKEN_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0x00, 0xc0, 0x00, 0x0b])

/**
 * Builds PNG bytes whose first chunk is not the header chunk.
 *
 * @returns The signature and a data chunk where the header chunk should be.
 */
function createHeaderlessPngBytes(): Uint8Array {
  const bytes = createPngBytes(64, 32)
  bytes.set([0x49, 0x44, 0x41, 0x54], 12)
  return bytes
}

/**
 * Builds WebP bytes whose first chunk is none of the three the parser reads.
 *
 * @returns A RIFF WebP file whose first chunk is an alpha chunk.
 */
function createUnknownChunkWebpBytes(): Uint8Array {
  const bytes = createLossyWebpBytes(64, 32)
  bytes.set([0x41, 0x4c, 0x50, 0x48], 12)
  return bytes
}

/**
 * Builds lossy WebP bytes without the key frame's start code.
 *
 * @returns A `VP8 ` file whose bitstream starts with other bytes.
 */
function createDamagedLossyWebpBytes(): Uint8Array {
  const bytes = createLossyWebpBytes(64, 32)
  bytes.set([0x00, 0x00, 0x00], 23)
  return bytes
}

/**
 * Builds lossless WebP bytes without the bitstream's signature byte.
 *
 * @returns A `VP8L` file whose bitstream starts with another byte.
 */
function createDamagedLosslessWebpBytes(): Uint8Array {
  const bytes = createLosslessWebpBytes(64, 32)
  bytes[20] = 0x00
  return bytes
}

/**
 * Builds a RIFF file that is not a WebP file and not text.
 *
 * @returns A RIFF header with a size no UTF-8 text holds and the form type
 * of a sound file.
 */
function createWaveBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x80, 0x80, 0x80, 0x80, 0x57, 0x41, 0x56, 0x45
  ])
}

describe("parseChatAttachments", () => {
  it("parses a request without attachments as none", () => {
    const parsed = parseChatAttachments(undefined)

    expect(parsed).toEqual({ status: "parsed", attachments: [] })
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it("decodes each attachment and reads what it is from its bytes, in request order", () => {
    const png = Buffer.from(createPngBytes(64, 32))
    const jpeg = Buffer.from(createJpegBytes(300, 200))

    const parsed = parseChatAttachments([
      { name: "notes.md", content: buildAttachmentContent(NOTES_TEXT) },
      { name: "photo.png", content: buildAttachmentContent(png) },
      { name: "shot.jpg", content: buildAttachmentContent(jpeg) }
    ])

    expect(parsed).toEqual({
      status: "parsed",
      attachments: [
        {
          name: "notes.md",
          content: NOTES_TEXT,
          draft: { kind: "text", name: "notes.md", sizeBytes: 18 }
        },
        {
          name: "photo.png",
          content: png,
          draft: {
            kind: "image",
            name: "photo.png",
            sizeBytes: 33,
            mediaType: "image/png",
            width: 64,
            height: 32
          }
        },
        {
          name: "shot.jpg",
          content: jpeg,
          draft: {
            kind: "image",
            name: "shot.jpg",
            sizeBytes: jpeg.length,
            mediaType: "image/jpeg",
            width: 300,
            height: 200
          }
        }
      ]
    })
    if (parsed.status !== "parsed") throw new Error("Expected a parse")
    expect(Object.isFrozen(parsed.attachments)).toBe(true)
    expect(Object.isFrozen(parsed.attachments[0])).toBe(true)
    expect(Object.isFrozen(parsed.attachments[0]?.draft)).toBe(true)
  })

  it("stops at the first attachment whose content Lys cannot send and names it", () => {
    const parsed = parseChatAttachments([
      { name: "notes.md", content: buildAttachmentContent(NOTES_TEXT) },
      { name: "clip.gif", content: buildAttachmentContent(GIF_BYTES) },
      { name: "other.gif", content: buildAttachmentContent(GIF_BYTES) }
    ])

    expect(parsed).toEqual({ status: "unsupported", fileName: "clip.gif" })
  })

  it.each([
    ["a lossy WebP", createLossyWebpBytes(640, 480), 640, 480],
    ["a lossless WebP", createLosslessWebpBytes(100, 50), 100, 50],
    ["an extended WebP", createExtendedWebpBytes(1920, 1080), 1920, 1080]
  ])(
    "reads %s image's sides from its first chunk",
    (_label, bytes, width, height) => {
      const parsed = parseChatAttachments([
        { name: "photo.webp", content: buildAttachmentContent(bytes) }
      ])

      expect(parsed).toMatchObject({
        status: "parsed",
        attachments: [
          {
            draft: {
              kind: "image",
              mediaType: "image/webp",
              width,
              height,
              sizeBytes: bytes.length
            }
          }
        ]
      })
    }
  )

  it.each([
    ["a progressive JPEG", PROGRESSIVE_JPEG_BYTES, 300, 200],
    [
      "a JPEG with a fill byte and a restart marker before its frame header",
      PADDED_JPEG_BYTES,
      64,
      32
    ]
  ])(
    "reads %s's sides from its frame header",
    (_label, bytes, width, height) => {
      const parsed = parseChatAttachments([
        { name: "shot.jpg", content: buildAttachmentContent(bytes) }
      ])

      expect(parsed).toMatchObject({
        status: "parsed",
        attachments: [
          { draft: { kind: "image", mediaType: "image/jpeg", width, height } }
        ]
      })
    }
  )

  it.each([
    ["a JPEG whose scan starts before any frame header", SCAN_FIRST_JPEG_BYTES],
    ["a JPEG that ends within a segment", TRUNCATED_JPEG_BYTES],
    ["a JPEG with a byte where a marker should be", BROKEN_JPEG_BYTES],
    [
      "a PNG whose first chunk is not the header chunk",
      createHeaderlessPngBytes()
    ],
    ["a PNG whose header declares a zero side", createPngBytes(0, 32)],
    [
      "a WebP whose first chunk is none the parser reads",
      createUnknownChunkWebpBytes()
    ],
    [
      "a lossy WebP without the key frame's start code",
      createDamagedLossyWebpBytes()
    ],
    [
      "a lossless WebP without its signature byte",
      createDamagedLosslessWebpBytes()
    ],
    [
      "a lossy WebP that ends before its sides",
      createLossyWebpBytes(64, 32).slice(0, 29)
    ],
    [
      "a lossless WebP that ends before its sides",
      createLosslessWebpBytes(64, 32).slice(0, 24)
    ],
    [
      "an extended WebP that ends before its canvas sides",
      createExtendedWebpBytes(64, 32).slice(0, 29)
    ],
    ["a RIFF file that is not a WebP file", createWaveBytes()],
    ["bytes that are not UTF-8", new Uint8Array([0x41, 0xff, 0xfe, 0x42])],
    ["UTF-8 text with a NUL character", Buffer.from("Buy\u0000milk")],
    ["UTF-16 text", Buffer.from("Buy milk", "utf16le")]
  ])("refuses %s as neither text nor an image Lys sends", (_label, bytes) => {
    const parsed = parseChatAttachments([
      { name: "notes.md", content: buildAttachmentContent(NOTES_TEXT) },
      { name: "file.bin", content: buildAttachmentContent(bytes) }
    ])

    expect(parsed).toEqual({ status: "unsupported", fileName: "file.bin" })
  })

  it("treats UTF-8 text with accented characters and emoji as text", () => {
    const text = Buffer.from("Café ☕ 😀\n")

    expect(
      parseChatAttachments([
        { name: "café.md", content: buildAttachmentContent(text) }
      ])
    ).toEqual({
      status: "parsed",
      attachments: [
        {
          name: "café.md",
          content: text,
          draft: { kind: "text", name: "café.md", sizeBytes: text.length }
        }
      ]
    })
  })

  it("treats an empty file as text", () => {
    expect(parseChatAttachments([{ name: "empty.txt", content: "" }])).toEqual({
      status: "parsed",
      attachments: [
        {
          name: "empty.txt",
          content: Buffer.alloc(0),
          draft: { kind: "text", name: "empty.txt", sizeBytes: 0 }
        }
      ]
    })
  })
})
