import * as z from "zod"

/** Bytes in one mebibyte. */
const BYTES_PER_MEBIBYTE = 1024 * 1024

/**
 * Most UTF-8 bytes an attachment's name may have, inclusive: the file-name
 * limit of the file systems Lys stores attachments on.
 */
export const MAXIMUM_ATTACHMENT_NAME_BYTES = 255

/** Most bytes one attachment may have, inclusive. */
export const MAXIMUM_ATTACHMENT_BYTES = 10 * BYTES_PER_MEBIBYTE

/** Most bytes the attachments of one message may have together, inclusive. */
export const MAXIMUM_MESSAGE_ATTACHMENT_BYTES = 20 * BYTES_PER_MEBIBYTE

/** Most attachments one message may carry, inclusive. */
export const MAXIMUM_MESSAGE_ATTACHMENT_COUNT = 8

/**
 * Side, in pixels, of the square patch of an image that a vision model turns
 * into one token.
 *
 * @remarks The patch size of the Qwen 2.5 and Qwen 3 vision models, which
 * local vision models commonly follow; other models differ, so the estimate
 * built from it is approximate.
 */
export const IMAGE_PATCH_PIXELS = 28

/**
 * Most tokens one image is estimated to take, inclusive, however large it
 * is: vision models scale a large image down before they read it.
 */
export const MAXIMUM_IMAGE_TOKENS = 1_280

/** Validates the media type of an image Lys sends to a model. */
export const attachmentImageMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp"
])

/** Media type of an image Lys sends to a model. */
export type AttachmentImageMediaType = z.infer<
  typeof attachmentImageMediaTypeSchema
>

/**
 * Counts the UTF-8 bytes of a text.
 *
 * @param text - Any text.
 * @returns How many bytes its UTF-8 encoding has.
 */
function calculateUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Validates the name of an attachment, which is also its file name on disk.
 *
 * @remarks A name is non-empty, is neither `.` nor `..`, holds no `/` and no
 * NUL character, and has at most {@link MAXIMUM_ATTACHMENT_NAME_BYTES} UTF-8
 * bytes, so it names exactly one entry of the folder it is stored in.
 */
export const attachmentNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => name !== "." && name !== "..",
    "An attachment name is neither . nor .."
  )
  .refine(
    (name) => !name.includes("/") && !name.includes("\0"),
    "An attachment name holds no slash and no NUL character."
  )
  .refine(
    (name) => calculateUtf8ByteLength(name) <= MAXIMUM_ATTACHMENT_NAME_BYTES,
    `An attachment name has at most ${MAXIMUM_ATTACHMENT_NAME_BYTES} UTF-8 bytes.`
  )

/**
 * Validates the number Lys gives one attachment of a conversation.
 *
 * @remarks Numbers start at 1 and count up across the whole conversation, in
 * the order the attachments were sent; the model reads a file by its number.
 */
const attachmentNumberSchema = z.int().min(1)

/** Validates the size of an attachment's content in bytes; a file may be empty. */
const attachmentSizeSchema = z.int().min(0)

/** Validates one side of an image in pixels. */
const imageDimensionSchema = z.int().min(1)

/** Fields every attachment has before the conversation numbers it. */
const attachmentDraftBase = {
  /** Name of the attachment, unique within its message ignoring case. */
  name: attachmentNameSchema,
  /** Size of the content in bytes. */
  sizeBytes: attachmentSizeSchema
}

/**
 * Validates an image attachment before it is numbered: one the model sees
 * directly.
 */
const imageAttachmentDraftSchema = z.strictObject({
  kind: z.literal("image"),
  ...attachmentDraftBase,
  /** Media type read from the image's bytes. */
  mediaType: attachmentImageMediaTypeSchema,
  /** Width in pixels, read from the image's header. */
  width: imageDimensionSchema,
  /** Height in pixels, read from the image's header. */
  height: imageDimensionSchema
})

/**
 * Validates a text attachment before it is numbered: one the model reads
 * through the attachment reader when it needs it.
 */
const textAttachmentDraftSchema = z.strictObject({
  kind: z.literal("text"),
  ...attachmentDraftBase
})

/**
 * Validates one attachment of a message before the conversation numbers it,
 * selected by `kind`.
 */
export const conversationAttachmentDraftSchema = z.discriminatedUnion("kind", [
  imageAttachmentDraftSchema,
  textAttachmentDraftSchema
])

/** One attachment of a message before the conversation numbers it. */
export type ConversationAttachmentDraft = z.infer<
  typeof conversationAttachmentDraftSchema
>

/**
 * Validates one stored attachment of a user message, selected by `kind`.
 *
 * @remarks An `image` is sent to the model with the message it belongs to,
 * on every turn; `text` is read by the model through the attachment reader.
 * Each attachment has a number that is unique within its conversation.
 */
export const conversationAttachmentSchema = z.discriminatedUnion("kind", [
  imageAttachmentDraftSchema.extend({
    /** Number the model reads the attachment by; unique within the conversation. */
    number: attachmentNumberSchema
  }),
  textAttachmentDraftSchema.extend({
    /** Number the model reads the attachment by; unique within the conversation. */
    number: attachmentNumberSchema
  })
])

/** One stored attachment of a user message. */
export type ConversationAttachment = z.infer<
  typeof conversationAttachmentSchema
>

/** A stored attachment that is an image. */
export type ConversationImageAttachment = Extract<
  ConversationAttachment,
  { kind: "image" }
>

/**
 * Builds the key duplicate checks compare an attachment name by.
 *
 * @param name - Attachment name as given.
 * @returns The name in Unicode normalization form C and lower case, so two
 * names that differ only in case or in the composition of their accented
 * characters get the same key, as the file systems Lys stores attachments
 * on treat them.
 */
export function buildAttachmentNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase()
}

/**
 * Answers whether no two attachment names of a list are the same ignoring
 * case.
 *
 * @param names - Attachment names in list order.
 * @returns True when every name is distinct by
 * {@link buildAttachmentNameKey}.
 */
export function hasDistinctAttachmentNames(names: readonly string[]): boolean {
  return new Set(names.map(buildAttachmentNameKey)).size === names.length
}

/**
 * Estimates the tokens one image takes in a vision model's context.
 *
 * @param width - Width in pixels; positive.
 * @param height - Height in pixels; positive.
 * @returns One token per {@link IMAGE_PATCH_PIXELS} square patch, partial
 * patches counted whole, at most {@link MAXIMUM_IMAGE_TOKENS}.
 */
export function estimateImageTokens(width: number, height: number): number {
  const patches =
    Math.ceil(width / IMAGE_PATCH_PIXELS) *
    Math.ceil(height / IMAGE_PATCH_PIXELS)
  return Math.min(patches, MAXIMUM_IMAGE_TOKENS)
}

/** What the content of an attachment is, read from its bytes. */
export type AttachmentContent =
  | Readonly<{
      /** The bytes are an image Lys can send to a vision model. */
      kind: "image"
      /** Media type of the image. */
      mediaType: AttachmentImageMediaType
      /** Width in pixels. */
      width: number
      /** Height in pixels. */
      height: number
    }>
  | Readonly<{
      /** The bytes are UTF-8 text without a NUL character. */
      kind: "text"
    }>
  | Readonly<{
      /** The bytes are neither an image Lys sends nor text. */
      kind: "unsupported"
    }>

/** Content of an attachment that is text. */
const TEXT_CONTENT: AttachmentContent = Object.freeze({ kind: "text" })

/** Content of an attachment that is neither a supported image nor text. */
const UNSUPPORTED_CONTENT: AttachmentContent = Object.freeze({
  kind: "unsupported"
})

/** Bytes every PNG file starts with. */
const PNG_SIGNATURE = Object.freeze([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
])

/** Offset of the PNG header chunk's type, which follows the signature and the chunk length. */
const PNG_HEADER_TYPE_OFFSET = 12

/** Offset of the width in a PNG header chunk, followed by the height. */
const PNG_WIDTH_OFFSET = 16

/** Offset of the height in a PNG header chunk. */
const PNG_HEIGHT_OFFSET = 20

/** Byte that opens every JPEG marker. */
const JPEG_MARKER_PREFIX = 0xff

/** Bytes every JPEG file starts with: the marker prefix and the start-of-image marker. */
const JPEG_SIGNATURE = Object.freeze([0xff, 0xd8])

/**
 * JPEG start-of-frame markers, whose segment carries the image's size: every
 * marker from C0 to CF except the Huffman table (C4), arithmetic table (CC),
 * and extension (C8) markers.
 */
const JPEG_FRAME_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

/** JPEG markers that stand alone, without a segment length. */
const JPEG_STANDALONE_MARKERS: ReadonlySet<number> = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8
])

/** JPEG markers after which no frame header follows: start of scan and end of image. */
const JPEG_TERMINAL_MARKERS: ReadonlySet<number> = new Set([0xda, 0xd9])

/** Offset of the height within a JPEG start-of-frame segment, from the marker. */
const JPEG_FRAME_HEIGHT_OFFSET = 5

/** Offset of the width within a JPEG start-of-frame segment, from the marker. */
const JPEG_FRAME_WIDTH_OFFSET = 7

/** Bytes of a WebP file's RIFF form type, at offset 8. */
const WEBP_FORM_TYPE_OFFSET = 8

/** Offset of the first chunk's type in a WebP file. */
const WEBP_CHUNK_TYPE_OFFSET = 12

/** Offset of the key-frame start code in a lossy WebP bitstream. */
const WEBP_LOSSY_START_CODE_OFFSET = 23

/** Bytes that start every lossy WebP key frame, after its frame tag. */
const WEBP_LOSSY_START_CODE = Object.freeze([0x9d, 0x01, 0x2a])

/** Offset of the width in a lossy WebP bitstream, followed by the height. */
const WEBP_LOSSY_WIDTH_OFFSET = 26

/** Offset of the height in a lossy WebP bitstream. */
const WEBP_LOSSY_HEIGHT_OFFSET = 28

/** Mask of the 14 bits that hold a lossy WebP side; the other 2 bits hold a scale. */
const WEBP_LOSSY_DIMENSION_MASK = 0x3fff

/** Offset of the lossless WebP signature byte. */
const WEBP_LOSSLESS_SIGNATURE_OFFSET = 20

/** Signature byte of a lossless WebP bitstream. */
const WEBP_LOSSLESS_SIGNATURE = 0x2f

/** Offset of the packed sides in a lossless WebP bitstream, after the signature. */
const WEBP_LOSSLESS_DIMENSIONS_OFFSET = 21

/** Mask of the 14 bits that hold a lossless WebP side, less one. */
const WEBP_LOSSLESS_DIMENSION_MASK = 0x3fff

/** Bits the lossless WebP height is shifted past the width. */
const WEBP_LOSSLESS_HEIGHT_SHIFT = 14

/** Offset of the canvas width in an extended WebP header, followed by the height. */
const WEBP_EXTENDED_WIDTH_OFFSET = 24

/** Offset of the canvas height in an extended WebP header. */
const WEBP_EXTENDED_HEIGHT_OFFSET = 27

/**
 * Answers whether bytes hold given bytes at an offset.
 *
 * @param bytes - Bytes to inspect.
 * @param offset - Position of the first expected byte.
 * @param expected - Bytes expected from that position.
 * @returns True when every expected byte is there.
 */
function hasBytesAt(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[]
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value)
}

/**
 * Answers whether bytes hold ASCII text at an offset.
 *
 * @param bytes - Bytes to inspect.
 * @param offset - Position of the text's first character.
 * @param text - ASCII text expected from that position.
 * @returns True when the text is there.
 */
function hasAsciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return hasBytesAt(
    bytes,
    offset,
    [...text].map((character) => character.codePointAt(0) ?? 0)
  )
}

/**
 * Reads a byte, treating a position past the end as zero.
 *
 * @param bytes - Bytes to read.
 * @param offset - Position of the byte.
 * @returns The byte, or 0 past the end.
 */
function readByte(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0
}

/**
 * Reads a big-endian unsigned 16-bit number.
 *
 * @param bytes - Bytes to read.
 * @param offset - Position of the number's high byte.
 * @returns The number; bytes past the end read as zero.
 */
function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return readByte(bytes, offset) * 0x100 + readByte(bytes, offset + 1)
}

/**
 * Reads a big-endian unsigned 32-bit number.
 *
 * @param bytes - Bytes to read.
 * @param offset - Position of the number's high byte.
 * @returns The number; bytes past the end read as zero.
 */
function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    readUint16BigEndian(bytes, offset) * 0x1_00_00 +
    readUint16BigEndian(bytes, offset + 2)
  )
}

/**
 * Reads a little-endian unsigned 16-bit number.
 *
 * @param bytes - Bytes to read.
 * @param offset - Position of the number's low byte.
 * @returns The number; bytes past the end read as zero.
 */
function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return readByte(bytes, offset) + readByte(bytes, offset + 1) * 0x100
}

/**
 * Reads a little-endian unsigned 32-bit number.
 *
 * @param bytes - Bytes to read.
 * @param offset - Position of the number's low byte.
 * @returns The number; bytes past the end read as zero.
 */
function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    readUint16LittleEndian(bytes, offset) +
    readUint16LittleEndian(bytes, offset + 2) * 0x1_00_00
  )
}

/**
 * Reads a little-endian unsigned 24-bit number.
 *
 * @param bytes - Bytes to read.
 * @param offset - Position of the number's low byte.
 * @returns The number; bytes past the end read as zero.
 */
function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    readUint16LittleEndian(bytes, offset) +
    readByte(bytes, offset + 2) * 0x1_00_00
  )
}

/**
 * Builds the content of an image whose sides were read from its header.
 *
 * @param mediaType - Media type of the image.
 * @param width - Width read from the header.
 * @param height - Height read from the header.
 * @returns The image content, or unsupported when a side is zero, which no
 * image has: the header is damaged or the size is declared elsewhere.
 */
function buildImageContent(
  mediaType: AttachmentImageMediaType,
  width: number,
  height: number
): AttachmentContent {
  if (width === 0 || height === 0) return UNSUPPORTED_CONTENT
  return Object.freeze({ kind: "image", mediaType, width, height })
}

/**
 * Reads the size of a PNG image from its header chunk.
 *
 * @param bytes - Bytes that start with the PNG signature.
 * @returns The image content, or unsupported when the header chunk is not
 * where the format puts it.
 */
function readPngContent(bytes: Uint8Array): AttachmentContent {
  if (!hasAsciiAt(bytes, PNG_HEADER_TYPE_OFFSET, "IHDR"))
    return UNSUPPORTED_CONTENT
  return buildImageContent(
    "image/png",
    readUint32BigEndian(bytes, PNG_WIDTH_OFFSET),
    readUint32BigEndian(bytes, PNG_HEIGHT_OFFSET)
  )
}

/**
 * Reads the size of a JPEG image from its first start-of-frame segment.
 *
 * @param bytes - Bytes that start with the JPEG signature.
 * @returns The image content, or unsupported when no frame header precedes
 * the scan data or the end of the bytes.
 */
function readJpegContent(bytes: Uint8Array): AttachmentContent {
  let offset = JPEG_SIGNATURE.length
  while (offset + 1 < bytes.length) {
    if (readByte(bytes, offset) !== JPEG_MARKER_PREFIX)
      return UNSUPPORTED_CONTENT
    const marker = readByte(bytes, offset + 1)
    if (marker === JPEG_MARKER_PREFIX) {
      offset += 1
    } else if (JPEG_FRAME_MARKERS.has(marker)) {
      return buildImageContent(
        "image/jpeg",
        readUint16BigEndian(bytes, offset + JPEG_FRAME_WIDTH_OFFSET),
        readUint16BigEndian(bytes, offset + JPEG_FRAME_HEIGHT_OFFSET)
      )
    } else if (JPEG_TERMINAL_MARKERS.has(marker)) {
      return UNSUPPORTED_CONTENT
    } else if (JPEG_STANDALONE_MARKERS.has(marker)) {
      offset += 2
    } else {
      offset += 2 + readUint16BigEndian(bytes, offset + 2)
    }
  }
  return UNSUPPORTED_CONTENT
}

/**
 * Reads the size of a WebP image from its first chunk: a lossy or lossless
 * bitstream, or the extended header.
 *
 * @param bytes - Bytes that start with the WebP signature.
 * @returns The image content, or unsupported when the first chunk is none of
 * the three or its bitstream header is damaged.
 */
function readWebpContent(bytes: Uint8Array): AttachmentContent {
  if (hasAsciiAt(bytes, WEBP_CHUNK_TYPE_OFFSET, "VP8 ")) {
    if (!hasBytesAt(bytes, WEBP_LOSSY_START_CODE_OFFSET, WEBP_LOSSY_START_CODE))
      return UNSUPPORTED_CONTENT
    return buildImageContent(
      "image/webp",
      readUint16LittleEndian(bytes, WEBP_LOSSY_WIDTH_OFFSET) &
        WEBP_LOSSY_DIMENSION_MASK,
      readUint16LittleEndian(bytes, WEBP_LOSSY_HEIGHT_OFFSET) &
        WEBP_LOSSY_DIMENSION_MASK
    )
  }
  if (hasAsciiAt(bytes, WEBP_CHUNK_TYPE_OFFSET, "VP8L")) {
    if (
      readByte(bytes, WEBP_LOSSLESS_SIGNATURE_OFFSET) !==
      WEBP_LOSSLESS_SIGNATURE
    )
      return UNSUPPORTED_CONTENT
    const packedSides = readUint32LittleEndian(
      bytes,
      WEBP_LOSSLESS_DIMENSIONS_OFFSET
    )
    return buildImageContent(
      "image/webp",
      (packedSides & WEBP_LOSSLESS_DIMENSION_MASK) + 1,
      ((packedSides >>> WEBP_LOSSLESS_HEIGHT_SHIFT) &
        WEBP_LOSSLESS_DIMENSION_MASK) +
        1
    )
  }
  if (hasAsciiAt(bytes, WEBP_CHUNK_TYPE_OFFSET, "VP8X")) {
    return buildImageContent(
      "image/webp",
      readUint24LittleEndian(bytes, WEBP_EXTENDED_WIDTH_OFFSET) + 1,
      readUint24LittleEndian(bytes, WEBP_EXTENDED_HEIGHT_OFFSET) + 1
    )
  }
  return UNSUPPORTED_CONTENT
}

/**
 * Finds the image an attachment's bytes hold, by their signature.
 *
 * @param bytes - Attachment content.
 * @returns The image content for a PNG, JPEG, or WebP file with a readable
 * header, unsupported for one of those files with a damaged header, and
 * undefined for bytes that are none of the three.
 */
function findImageContent(bytes: Uint8Array): AttachmentContent | undefined {
  if (hasBytesAt(bytes, 0, PNG_SIGNATURE)) return readPngContent(bytes)
  if (hasBytesAt(bytes, 0, JPEG_SIGNATURE)) return readJpegContent(bytes)
  if (
    hasAsciiAt(bytes, 0, "RIFF") &&
    hasAsciiAt(bytes, WEBP_FORM_TYPE_OFFSET, "WEBP")
  )
    return readWebpContent(bytes)
  return undefined
}

/**
 * Answers whether bytes are text Lys gives a model to read.
 *
 * @param bytes - Attachment content.
 * @returns True when the bytes decode as UTF-8 and hold no NUL character,
 * which text written by a person never has and binary files, including
 * text in UTF-16, usually do.
 */
function isTextContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Parses what an attachment's content is from its bytes, never from its name.
 *
 * @param bytes - Attachment content; an empty file is text.
 * @returns An image with its media type and size for a PNG, JPEG, or WebP
 * file with a readable header; text for bytes that decode as UTF-8 without a
 * NUL character; unsupported otherwise, including an image of those formats
 * whose header cannot be read.
 */
export function parseAttachmentContent(bytes: Uint8Array): AttachmentContent {
  const imageContent = findImageContent(bytes)
  if (imageContent !== undefined) return imageContent
  return isTextContent(bytes) ? TEXT_CONTENT : UNSUPPORTED_CONTENT
}
