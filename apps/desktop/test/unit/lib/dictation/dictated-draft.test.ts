import { describe, expect, it } from "vitest"
import {
  buildDictatedDraft,
  buildDictationAnchor
} from "@/lib/dictation/dictated-draft"

describe("buildDictationAnchor", () => {
  it("splits the draft at the cursor", () => {
    expect(buildDictationAnchor("Hello world", 5)).toEqual({
      before: "Hello",
      after: " world"
    })
  })

  it.each([
    [-3, { before: "", after: "Hi" }],
    [99, { before: "Hi", after: "" }],
    [Number.NaN, { before: "", after: "Hi" }]
  ])("moves the cursor %d to the draft's nearest end", (cursor, anchor) => {
    expect(buildDictationAnchor("Hi", cursor)).toEqual(anchor)
  })
})

describe("buildDictatedDraft", () => {
  it("writes the dictated text into an empty draft as it is", () => {
    expect(buildDictatedDraft({ before: "", after: "" }, "Hello there.")).toBe(
      "Hello there."
    )
  })

  it("keeps what was typed on both sides of the cursor", () => {
    const anchor = buildDictationAnchor("Dear Ana, see you soon", 9)

    expect(buildDictatedDraft(anchor, "thanks for the note")).toBe(
      "Dear Ana, thanks for the note see you soon"
    )
  })

  it("adds a space after typed text that ends in a word", () => {
    expect(buildDictatedDraft({ before: "Hello", after: "" }, "world")).toBe(
      "Hello world"
    )
  })

  it("adds a space before typed text that starts with a word", () => {
    expect(buildDictatedDraft({ before: "", after: "world" }, "Hello")).toBe(
      "Hello world"
    )
  })

  it.each([
    ["Hello ", "world", "Hello world"],
    ["Hello\n", "world", "Hello\nworld"],
    ["(", "world", "(world"]
  ])(
    "adds no space after typed text that ends with %j",
    (before, text, draft) => {
      expect(buildDictatedDraft({ before, after: "" }, text)).toBe(draft)
    }
  )

  it.each([
    [" world", "Hello world"],
    [".", "Hello."],
    [", world", "Hello, world"],
    [")", "Hello)"]
  ])("adds no space before typed text that starts with %j", (after, draft) => {
    expect(buildDictatedDraft({ before: "", after }, "Hello")).toBe(draft)
  })

  it("drops the white space around the dictated text", () => {
    expect(buildDictatedDraft({ before: "A", after: "B" }, "  and \n")).toBe(
      "A and B"
    )
  })

  it.each(["", "   "])(
    "leaves the typed text unchanged while the dictated text is %j",
    (text) => {
      expect(
        buildDictatedDraft({ before: "Hello", after: "world" }, text)
      ).toBe("Helloworld")
    }
  )

  it("replaces an earlier update with the next one, since each carries the whole text", () => {
    const anchor = buildDictationAnchor("Note: ", 6)

    expect(buildDictatedDraft(anchor, "by milk")).toBe("Note: by milk")
    expect(buildDictatedDraft(anchor, "Buy milk today.")).toBe(
      "Note: Buy milk today."
    )
  })
})
