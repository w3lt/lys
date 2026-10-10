import { describe, expect, it } from "vitest"
import { decodePageText } from "../../../../../../src/modules/tool/builtIn/web/pageCharset"

/** "café" in windows-1252. */
const CAFE_IN_WINDOWS_1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9])

/** "café" in UTF-8. */
const CAFE_IN_UTF_8 = new TextEncoder().encode("café")

/**
 * Builds the bytes of an ASCII text followed by extra bytes.
 *
 * @param text - ASCII text.
 * @param tail - Bytes appended after it.
 * @returns The combined bytes.
 */
function buildBytes(text: string, tail: Uint8Array): Uint8Array {
  return Uint8Array.from([...new TextEncoder().encode(text), ...tail])
}

describe("decodePageText", () => {
  it("decodes UTF-8 when nothing names an encoding", () => {
    expect(decodePageText(CAFE_IN_UTF_8, undefined, "text/plain")).toBe("café")
  })

  it("uses the charset the header names", () => {
    expect(
      decodePageText(CAFE_IN_WINDOWS_1252, "windows-1252", "text/plain")
    ).toBe("café")
  })

  it("uses a <meta> charset of an HTML page when the header names none", () => {
    const bytes = buildBytes(
      '<html><head><meta charset="windows-1252"></head><body>',
      CAFE_IN_WINDOWS_1252
    )

    expect(decodePageText(bytes, undefined, "text/html")).toContain("café")
  })

  it("uses a <meta http-equiv> charset", () => {
    const bytes = buildBytes(
      '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"><p>',
      CAFE_IN_WINDOWS_1252
    )

    expect(decodePageText(bytes, undefined, "text/html")).toContain("café")
  })

  it("prefers the header charset over a <meta> charset", () => {
    const bytes = buildBytes('<meta charset="utf-8"><p>', CAFE_IN_WINDOWS_1252)

    expect(decodePageText(bytes, "windows-1252", "text/html")).toContain("café")
  })

  it("prefers a byte order mark over the header charset", () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...CAFE_IN_UTF_8])

    expect(decodePageText(bytes, "windows-1252", "text/plain")).toBe("café")
  })

  it("decodes UTF-16 marked by its byte order mark", () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])

    expect(decodePageText(bytes, undefined, "text/plain")).toBe("hi")
  })

  it("does not look for a <meta> charset in a plain-text page", () => {
    const bytes = buildBytes('<meta charset="windows-1252"> ', CAFE_IN_UTF_8)

    expect(decodePageText(bytes, undefined, "text/plain")).toContain("café")
  })

  it("falls through an unknown charset label to the next source", () => {
    expect(decodePageText(CAFE_IN_UTF_8, "no-such-charset", "text/plain")).toBe(
      "café"
    )
  })

  it("replaces invalid bytes instead of failing", () => {
    expect(
      decodePageText(Uint8Array.from([0x61, 0xff, 0x62]), "utf-8", "text/plain")
    ).toBe("a�b")
  })
})
