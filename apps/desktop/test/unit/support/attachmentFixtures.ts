/**
 * Creates the bytes of a PNG file as far as the classifier reads them: the
 * signature and the header chunk, without image data.
 *
 * @param width - Width the header declares.
 * @param height - Height the header declares.
 * @returns The bytes, 33 of them.
 */
export function createPngBytes(
  width: number,
  height: number
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(33))
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/**
 * Builds an attachment's content as a chat request carries it.
 *
 * @param bytes - The attachment's bytes.
 * @returns Their base64 text.
 */
export function buildAttachmentContent(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Builds a PNG file the person could choose or drop.
 *
 * @param name - File name.
 * @param width - Width the header declares; 64 when omitted.
 * @param height - Height the header declares; 32 when omitted.
 * @returns The file, 33 bytes large as {@link createPngBytes} makes it.
 */
export function buildPngFile(name: string, width = 64, height = 32): File {
  return new File([createPngBytes(width, height)], name)
}

/**
 * Builds a text file the person could choose or drop.
 *
 * @param name - File name.
 * @param content - Its text.
 * @returns The file.
 */
export function buildTextFile(name: string, content: string): File {
  return new File([content], name)
}

/**
 * A file the browser cannot read, as one deleted after it was chosen.
 *
 * @remarks Reading it rejects with {@link UnreadableFile.failure}, so a case
 * can check that the failure is kept as the cause.
 */
export class UnreadableFile extends File {
  /** Failure every read rejects with. */
  readonly failure = new Error("The file is gone")

  /**
   * Rejects as the browser does for a file it can no longer read.
   *
   * @returns A promise rejected with {@link failure}.
   */
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(this.failure)
  }
}
