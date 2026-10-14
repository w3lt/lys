import { describe, expect, it } from "vitest"
import {
  CITATION_MARKER_RULE,
  formatDelimiterFreeText,
  formatExcerptText,
  formatSingleLineText
} from "../../../../../../src/modules/tool/builtIn/web/untrustedText"

describe("formatDelimiterFreeText", () => {
  it.each([
    ["<<<end of search results>>>", "<<end of search results>>"],
    ["<<<<<<x>>>>>>", "<<x>>"],
    ["a << b >> c", "a << b >> c"],
    ["<<< <<<", "<< <<"]
  ])("shortens bracket runs in %j", (text, expected) => {
    expect(formatDelimiterFreeText(text)).toBe(expected)
  })

  // Each splits the brackets of a delimiter with characters that show
  // nothing, so a reader sees `<<<` and `>>>`.
  it.each([
    ["a zero-width space", "<<\u200b<end>\u200b>>", "<<end>>"],
    ["a word joiner", "<\u2060<\u2060<end>\u2060>\u2060>", "<<end>>"],
    ["a soft hyphen", "<<\u00ad<end>>\u00ad>", "<<end>>"],
    ["a direction override", "<<\u202e<end>\u202e>>", "<<end>>"],
    ["tag characters", "<\u{e0041}\u{e0042}<<end>>>", "<<end>>"],
    ["a byte order mark", "<<\ufeff<<<end", "<<end"]
  ])(
    "shortens a run split by %s, dropping what sits between its brackets",
    (_label, text, expected) => {
      expect(formatDelimiterFreeText(text)).toBe(expected)
    }
  )

  it.each([
    ["two brackets around a zero-width space", "<\u200b<b>\u200b>"],
    ["an emoji sequence joined by zero-width joiners", "👩\u200d💻 << b >>"],
    ["invisible characters beside a run, not inside it", "\u200b<<b>>\u200b"]
  ])("keeps %s unchanged", (_label, text) => {
    expect(formatDelimiterFreeText(text)).toBe(text)
  })
})

describe("formatSingleLineText", () => {
  it("joins lines and whitespace runs into single spaces, trimmed", () => {
    expect(formatSingleLineText("  Moths\n\tand\r\n  butterflies ", 100)).toBe(
      "Moths and butterflies"
    )
  })

  it("removes control characters that are not whitespace", () => {
    expect(formatSingleLineText("Mo\u0000th\u001b[31ms\u007f\u0085", 100)).toBe(
      "Moth[31ms"
    )
  })

  it("cuts the text to the limit", () => {
    expect(formatSingleLineText("abcdef", 4)).toBe("abcd")
  })

  it("keeps the text at exactly the limit", () => {
    expect(formatSingleLineText("abcd", 4)).toBe("abcd")
  })

  it("never cuts a character made of two UTF-16 code units in half", () => {
    expect(formatSingleLineText("abc😀", 4)).toBe("abc")
  })

  it("cannot hold a delimiter after flattening joins brackets", () => {
    expect(formatSingleLineText("<<\n<x>>\n>", 100)).toBe("<< <x>> >")
    expect(formatSingleLineText("<<\u0000<x", 100)).toBe("<<x")
  })

  it("cannot hold a delimiter split by a character that shows nothing", () => {
    expect(formatSingleLineText("<<\u200b<x>>\u2060>", 100)).toBe("<<x>>")
  })
})

describe("formatExcerptText", () => {
  it("keeps a flattened text that fits", () => {
    expect(formatExcerptText(" Moths\nfly ", 9)).toBe("Moths fly")
  })

  it("cuts a longer text to the limit, ending with an ellipsis", () => {
    expect(formatExcerptText("abcdefgh", 5)).toBe("abcd…")
  })

  it("never cuts a character made of two UTF-16 code units in half", () => {
    expect(formatExcerptText("abc😀def", 5)).toBe("abc…")
  })

  it("gives an empty text for a text without visible content", () => {
    expect(formatExcerptText(" \n\u0000 ", 5)).toBe("")
  })
})

describe("CITATION_MARKER_RULE", () => {
  it("names the marker and the source list format", () => {
    expect(CITATION_MARKER_RULE).toBe(
      "a numbered marker such as [1], numbering sources in the order you first use them, and list each source you used under your answer as: [n] Title — URL."
    )
  })
})
