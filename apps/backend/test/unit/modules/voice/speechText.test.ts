import { describe, expect, it } from "vitest"
import {
  SpeechSentenceBuffer,
  splitForVoice
} from "../../../../src/modules/voice/speechText"

/** Speaks a whole finished reply, as a `start` speech of a done reply does. */
function speakFinished(markdown: string): string[] {
  const buffer = new SpeechSentenceBuffer("start")
  return [
    ...buffer.loadSnapshot({ text: markdown, lastTextPart: "closed" }),
    ...buffer.finish()
  ]
}

/** Streams fragments into a `start` speech and collects what it hands out. */
function speakStreamed(fragments: readonly string[]): string[] {
  const buffer = new SpeechSentenceBuffer("start")
  const sentences = buffer.loadSnapshot({ text: "", lastTextPart: "open" })
  for (const fragment of fragments) sentences.push(...buffer.push(fragment))
  return [...sentences, ...buffer.finish()]
}

describe("speech text", () => {
  it("ends a plain paragraph with a sentence boundary", () => {
    expect(speakFinished("Hello there")).toEqual(["Hello there."])
  })

  it("speaks a link by its text", () => {
    expect(
      speakFinished("See [the docs](https://example.com/docs) now")
    ).toEqual(["See the docs now."])
  })

  it("drops a bare URL", () => {
    expect(speakFinished("See https://example.com/docs now")).toEqual([
      "See now."
    ])
  })

  it("drops code blocks, math, tables, and citation markers", () => {
    const markdown = [
      "Before [1].",
      "",
      "```ts",
      "const secret = 1",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "$$x^2$$",
      "",
      "After."
    ].join("\n")
    expect(speakFinished(markdown)).toEqual(["Before.", "After."])
  })

  it("keeps bracketed numbers that are not citation markers", () => {
    expect(speakFinished("Index [0] and [007] stay [2].")).toEqual([
      "Index [0] and [007] stay."
    ])
  })

  it("keeps inline code as words", () => {
    expect(speakFinished("Run `git status` first.")).toEqual([
      "Run git status first."
    ])
  })

  it("ends list items as sentences", () => {
    expect(speakFinished("- one\n- two\n- three")).toEqual([
      "one.",
      "two.",
      "three."
    ])
  })

  it("flattens headings into their own sentences", () => {
    expect(speakFinished("# Title\n\nBody text.")).toEqual([
      "Title.",
      "Body text."
    ])
  })
})

describe("SpeechSentenceBuffer", () => {
  it("hands out a sentence once a later sentence follows it", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(buffer.loadSnapshot({ text: "", lastTextPart: "open" })).toEqual([])
    expect(buffer.push("Hello the")).toEqual([])
    expect(buffer.push("re. How are")).toEqual(["Hello there."])
    expect(buffer.push(" you?")).toEqual([])
    expect(buffer.finish()).toEqual(["How are you?"])
  })

  it("does not end a sentence at the period of a decimal number", () => {
    expect(
      speakStreamed(["It costs $3", ".", "50", " today.", " Bye."])
    ).toEqual(["It costs $3.50 today.", "Bye."])
  })

  it("does not end a sentence at the period of a version", () => {
    expect(speakStreamed(["Version 2", ".", "5 is out now.", " Bye."])).toEqual(
      ["Version 2.5 is out now.", "Bye."]
    )
  })

  it("does not end a sentence at the period of an abbreviation", () => {
    expect(speakStreamed(["See Fig.", " 3 for details.", " Done."])).toEqual([
      "See Fig. 3 for details.",
      "Done."
    ])
  })

  it("hands out a sentence ended by a line break at once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.push("First point.\n\n2")).toEqual(["First point."])
  })

  it("replays the final sentences of a snapshot still being written", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(
      buffer.loadSnapshot({ text: "One. Two. Thr", lastTextPart: "open" })
    ).toEqual(["One.", "Two."])
    expect(buffer.push("ee. Four")).toEqual(["Three."])
  })

  it("joins a reply being written at the sentence being written", () => {
    const buffer = new SpeechSentenceBuffer("current")
    expect(
      buffer.loadSnapshot({ text: "One. Two. Thr", lastTextPart: "open" })
    ).toEqual([])
    expect(buffer.push("ee. Four.")).toEqual(["Three."])
    expect(buffer.finish()).toEqual(["Four."])
  })

  it("joins at the next text part when the snapshot's text part ended", () => {
    const buffer = new SpeechSentenceBuffer("current")
    expect(
      buffer.loadSnapshot({
        text: "Done earlier. Let me check:",
        lastTextPart: "closed"
      })
    ).toEqual([])
    expect(buffer.push("\n\nIt is sunny. ")).toEqual([])
    expect(buffer.finish()).toEqual(["It is sunny."])
  })

  it("flushes the remainder on finish, however short, only once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "One. Trai", lastTextPart: "open" })
    expect(buffer.finish()).toEqual(["Trai."])
    expect(buffer.finish()).toEqual([])
  })

  it("holds an unterminated code fence back until it closes", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.push("Before.\n\n```\nconst x = 1;\n")).toEqual([])
    expect(buffer.push("const y = 2;\n```\nAfter. Next")).toEqual([
      "Before.",
      "After."
    ])
  })
})

describe("splitForVoice", () => {
  it("keeps a sentence that fits in one voice message", () => {
    expect(splitForVoice("Short.")).toEqual(["Short."])
  })

  it("splits a long sentence at the last space before each limit", () => {
    const sentence = Array.from({ length: 1000 }, () => "word").join(" ")
    const pieces = splitForVoice(sentence)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(2000)
      expect(piece).toBe(piece.trim())
    }
    expect(pieces.join(" ")).toBe(sentence)
  })

  it("cuts a run without spaces at the limit", () => {
    expect(
      splitForVoice("x".repeat(4500)).map((piece) => piece.length)
    ).toEqual([2000, 2000, 500])
  })

  it("never splits a surrogate pair", () => {
    expect(splitForVoice(`${"x".repeat(1999)}😀y`)).toEqual([
      "x".repeat(1999),
      "😀y"
    ])
  })
})
