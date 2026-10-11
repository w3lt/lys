/** Media type of a page body Lys reads. */
export type PageMediaType = "text/html" | "text/plain"

/** Encoding used when neither the body nor its headers name one. */
const DEFAULT_PAGE_ENCODING = "utf-8"

/** Bytes at the start of an HTML body searched for a `<meta>` charset. */
const META_CHARSET_PRESCAN_BYTES = 1_024

/**
 * Finds the text of each HTML `<meta>` element, up to its closing `>` or the
 * end of the searched text.
 */
const META_ELEMENT_PATTERN = /<meta[^>]*/gi

/** Finds the charset label declared in the text of one `<meta>` element. */
const META_CHARSET_PATTERN = /charset\s*=\s*(?:["']\s*)?([\w.:-]+)/i

/**
 * Encodings a `<meta>` element names but cannot be in force, each mapped to
 * the encoding browsers decode with instead.
 *
 * @remarks Markup whose `<meta>` element reads as ASCII is not UTF-16, and
 * `x-user-defined` is not meant for pages. The HTML encoding prescan maps
 * these the same way.
 */
const META_CHARSET_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ["utf-16le", "utf-8"],
  ["utf-16be", "utf-8"],
  ["x-user-defined", "windows-1252"]
])

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
 * @returns The label the first declaring `<meta>` element names, or
 * undefined when none is found in the first
 * {@link META_CHARSET_PRESCAN_BYTES} bytes.
 */
function findMetaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(
    bytes.subarray(0, META_CHARSET_PRESCAN_BYTES)
  )
  for (const [element] of head.matchAll(META_ELEMENT_PATTERN)) {
    const label = META_CHARSET_PATTERN.exec(element)?.[1]
    if (label !== undefined) return label
  }
  return undefined
}

/**
 * Creates a decoder for an encoding label.
 *
 * @param label - Encoding label from a header, a `<meta>` element, or a byte
 * order mark; undefined when the source names none.
 * @returns A non-fatal decoder, or undefined when there is no label or it
 * names no encoding the runtime supports.
 */
function createPageDecoder(label: string | undefined): TextDecoder | undefined {
  if (label === undefined) return undefined
  try {
    return new TextDecoder(label)
  } catch (error) {
    if (error instanceof RangeError) return undefined
    throw error
  }
}

/**
 * Creates a decoder for the charset an HTML body's `<meta>` element names.
 *
 * @param bytes - HTML body bytes.
 * @returns A non-fatal decoder for the named encoding, or for the encoding
 * {@link META_CHARSET_REPLACEMENTS} uses instead; undefined when no
 * `<meta>` element names a charset the runtime supports.
 */
function createMetaCharsetDecoder(bytes: Uint8Array): TextDecoder | undefined {
  const decoder = createPageDecoder(findMetaCharset(bytes))
  if (decoder === undefined) return undefined
  const replacement = META_CHARSET_REPLACEMENTS.get(decoder.encoding)
  return replacement === undefined ? decoder : new TextDecoder(replacement)
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
 * in the first 1,024 bytes, and UTF-8 otherwise. A `<meta>` charset of
 * UTF-16 decodes as UTF-8, and one of `x-user-defined` as windows-1252. An
 * unsupported label falls through to the next source. Invalid bytes become
 * replacement characters.
 */
export function decodePageText(
  bytes: Uint8Array,
  headerCharset: string | undefined,
  mediaType: PageMediaType
): string {
  const decoder =
    createPageDecoder(findByteOrderMarkEncoding(bytes)) ??
    createPageDecoder(headerCharset) ??
    (mediaType === "text/html" ? createMetaCharsetDecoder(bytes) : undefined) ??
    new TextDecoder(DEFAULT_PAGE_ENCODING)
  return decoder.decode(bytes)
}
