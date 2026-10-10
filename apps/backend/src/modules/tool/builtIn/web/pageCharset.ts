/** Media type of a page body Lys reads. */
export type PageMediaType = "text/html" | "text/plain"

/** Encoding used when neither the body nor its headers name one. */
const DEFAULT_PAGE_ENCODING = "utf-8"

/** Bytes at the start of an HTML body searched for a `<meta>` charset. */
const META_CHARSET_PRESCAN_BYTES = 1_024

/** Finds a charset declared by an HTML `<meta>` element. */
const META_CHARSET_PATTERN = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i

/** Byte order marks and the encoding each one names, checked in order. */
const BYTE_ORDER_MARKS: readonly (readonly [
  marker: readonly number[],
  encoding: string
])[] = Object.freeze([
  [Object.freeze([0xef, 0xbb, 0xbf]), "utf-8"],
  [Object.freeze([0xfe, 0xff]), "utf-16be"],
  [Object.freeze([0xff, 0xfe]), "utf-16le"]
])

/**
 * Finds the encoding a byte order mark at the start of a body names.
 *
 * @param bytes - Body bytes.
 * @returns The encoding, or undefined when the body starts with no mark.
 */
function findByteOrderMarkEncoding(bytes: Uint8Array): string | undefined {
  const match = BYTE_ORDER_MARKS.find(([marker]) =>
    marker.every((byte, index) => bytes[index] === byte)
  )
  return match?.[1]
}

/**
 * Finds the charset an HTML body declares in a `<meta>` element near its
 * start.
 *
 * @param bytes - HTML body bytes.
 * @returns The declared label, or undefined when none is found in the first
 * {@link META_CHARSET_PRESCAN_BYTES} bytes.
 */
function findMetaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(
    bytes.subarray(0, META_CHARSET_PRESCAN_BYTES)
  )
  return META_CHARSET_PATTERN.exec(head)?.[1]
}

/**
 * Creates a decoder for an encoding label.
 *
 * @param label - Encoding label from a header, a `<meta>` element, or a byte
 * order mark.
 * @returns A non-fatal decoder, or undefined when the label names no
 * encoding the runtime supports.
 */
function createPageDecoder(label: string): TextDecoder | undefined {
  try {
    return new TextDecoder(label)
  } catch (error) {
    if (error instanceof RangeError) return undefined
    throw error
  }
}

/**
 * Decodes a page body into text.
 *
 * @param bytes - Complete or truncated body bytes, after any decompression.
 * @param headerCharset - Charset the response's `Content-Type` named, or
 * undefined when it named none.
 * @param mediaType - Media type of the body; only HTML is searched for a
 * `<meta>` charset.
 * @returns The text. The encoding is chosen as browsers do: a byte order
 * mark first, then the header's charset, then, for HTML, a `<meta>` charset
 * in the first 1,024 bytes, and UTF-8 otherwise. An unsupported label falls
 * through to the next source. Invalid bytes become replacement characters.
 */
export function decodePageText(
  bytes: Uint8Array,
  headerCharset: string | undefined,
  mediaType: PageMediaType
): string {
  const metaCharset =
    mediaType === "text/html" ? findMetaCharset(bytes) : undefined
  const declaredLabels = [
    findByteOrderMarkEncoding(bytes),
    headerCharset,
    metaCharset
  ]
  for (const label of declaredLabels) {
    const decoder = label === undefined ? undefined : createPageDecoder(label)
    if (decoder !== undefined) return decoder.decode(bytes)
  }
  return new TextDecoder(DEFAULT_PAGE_ENCODING).decode(bytes)
}
