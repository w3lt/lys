import type { ConversationAttachment } from "@lys/share"

/**
 * Creates the bytes of a PNG file as far as the classifier reads them: the
 * signature and the header chunk, without image data.
 *
 * @param width - Width the header declares.
 * @param height - Height the header declares.
 * @returns The bytes.
 */
export function createPngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/**
 * Creates the bytes of a JPEG file as far as the classifier reads them: the
 * start of image, an application segment, and a baseline frame header.
 *
 * @param width - Width the frame header declares.
 * @param height - Height the frame header declares.
 * @returns The bytes.
 */
export function createJpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(2 + 2 + 16 + 2 + 2 + 1 + 2 + 2)
  const view = new DataView(bytes.buffer)
  bytes.set([0xff, 0xd8], 0)
  bytes.set([0xff, 0xe0], 2)
  view.setUint16(4, 16)
  bytes.set([0xff, 0xc0], 20)
  view.setUint16(22, 17)
  bytes[24] = 8
  view.setUint16(25, height)
  view.setUint16(27, width)
  return bytes
}

/**
 * Creates the bytes of a lossy WebP file as far as the classifier reads
 * them: the RIFF header and the start of the `VP8 ` bitstream.
 *
 * @param width - Width the bitstream declares.
 * @param height - Height the bitstream declares.
 * @returns The bytes.
 */
export function createLossyWebpBytes(
  width: number,
  height: number
): Uint8Array {
  const bytes = new Uint8Array(30)
  const view = new DataView(bytes.buffer)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, 22, true)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x20], 12)
  view.setUint32(16, 10, true)
  bytes.set([0x9d, 0x01, 0x2a], 23)
  view.setUint16(26, width, true)
  view.setUint16(28, height, true)
  return bytes
}

/**
 * Creates the bytes of a lossless WebP file as far as the classifier reads
 * them: the RIFF header and the start of the `VP8L` bitstream.
 *
 * @param width - Width the bitstream declares.
 * @param height - Height the bitstream declares.
 * @returns The bytes.
 */
export function createLosslessWebpBytes(
  width: number,
  height: number
): Uint8Array {
  const bytes = new Uint8Array(25)
  const view = new DataView(bytes.buffer)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, 17, true)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12)
  view.setUint32(16, 5, true)
  bytes[20] = 0x2f
  view.setUint32(21, (width - 1) | ((height - 1) << 14), true)
  return bytes
}

/**
 * Creates the bytes of an extended WebP file as far as the classifier reads
 * them: the RIFF header and the `VP8X` chunk.
 *
 * @param width - Canvas width the chunk declares.
 * @param height - Canvas height the chunk declares.
 * @returns The bytes.
 */
export function createExtendedWebpBytes(
  width: number,
  height: number
): Uint8Array {
  const bytes = new Uint8Array(30)
  const view = new DataView(bytes.buffer)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, 22, true)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x58], 12)
  view.setUint32(16, 10, true)
  const canvasWidth = width - 1
  const canvasHeight = height - 1
  bytes[24] = canvasWidth & 0xff
  bytes[25] = (canvasWidth >> 8) & 0xff
  bytes[26] = (canvasWidth >> 16) & 0xff
  bytes[27] = canvasHeight & 0xff
  bytes[28] = (canvasHeight >> 8) & 0xff
  bytes[29] = (canvasHeight >> 16) & 0xff
  return bytes
}

/**
 * Builds an attachment's content as a chat request carries it.
 *
 * @param bytes - The attachment's bytes.
 * @returns Their base64 text.
 */
export function buildAttachmentContent(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

/**
 * Creates a stored text attachment.
 *
 * @param number - Number the conversation gave it.
 * @param name - Attachment name.
 * @param sizeBytes - Size of its file; 12 bytes when omitted.
 * @returns The attachment.
 */
export function createTextAttachment(
  number: number,
  name: string,
  sizeBytes = 12
): ConversationAttachment {
  return { kind: "text", number, name, sizeBytes }
}

/**
 * Creates a stored PNG attachment.
 *
 * @param number - Number the conversation gave it.
 * @param name - Attachment name.
 * @param sides - Width and height in pixels; 64 by 32 when omitted.
 * @returns The attachment, 33 bytes large as {@link createPngBytes} makes it.
 */
export function createImageAttachment(
  number: number,
  name: string,
  sides: Readonly<{ width: number; height: number }> = {
    width: 64,
    height: 32
  }
): ConversationAttachment {
  return {
    kind: "image",
    number,
    name,
    sizeBytes: 33,
    mediaType: "image/png",
    width: sides.width,
    height: sides.height
  }
}
