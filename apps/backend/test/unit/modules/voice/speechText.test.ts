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

describe("SpeechSentenceBuffer structure changes", () => {
  it("speaks a streamed table's surroundings as it does the whole text", () => {
    const fragments = [
      "Here is the table:",
      "\n\n| No",
      ". | Item |",
      "\n|---",
      "|---|",
      "\n| 1 | Apple |",
      "\n\nThat's the list",
      ". Anything else?"
    ]
    expect(speakStreamed(fragments)).toEqual(speakFinished(fragments.join("")))
    expect(speakStreamed(fragments)).toEqual([
      "Here is the table:.",
      "That's the list.",
      "Anything else?"
    ])
  })

  it("speaks prose with a pipe once its paragraph ends", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.push("Run a | b first. Then c")).toEqual([])
    expect(buffer.push("\n\nDone")).toEqual(["Run a | b first.", "Then c."])
  })

  it("speaks a sentence once when a later dollar sign turns it into math", () => {
    const fragments = ["It costs $3. Then", " $4 more. Bye."]
    expect(speakStreamed(fragments)).toEqual(speakFinished(fragments.join("")))
    expect(speakStreamed(fragments)).toEqual(["It costs 4 more.", "Bye."])
  })

  it("speaks the sentences before an unpaired dollar sign at once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.push("Intro here. Pay $3 today. Then go")).toEqual([
      "Intro here."
    ])
    expect(buffer.push("\n\nDone")).toEqual(["Pay $3 today.", "Then go."])
  })

  it("does not hold for a dollar sign in inline code", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.push("Run `echo $HOME` now. Then stop")).toEqual([
      "Run echo $HOME now."
    ])
  })

  it.each([
    ["inline code", ["Run `a` then $3. Next", " $4 more. Bye."]],
    ["emphasis", ["It is *cheap $3. Then* $4 more", ". Bye."]],
    ["a link", ["See [the $3 plan](https://x.y). Then", " $4 more. Bye."]]
  ])(
    "holds text from a dollar sign that follows %s in its block",
    (_place, fragments) => {
      expect(speakStreamed(fragments)).toEqual(
        speakFinished(fragments.join(""))
      )
    }
  )

  it("speaks what precedes a dollar sign held inside emphasis at once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.push("Run `a` now. Then *pay $3*. Next")).toEqual([
      "Run a now."
    ])
  })

  it.each([
    [
      "a citation marker",
      ["Intro here. Source [1].", "\n\n[", "1]: https://example.com\n"]
    ],
    [
      "a full link reference",
      ["Intro here. See [the docs][d] now.", "\n\n[d", "]: https://x.y\n"]
    ],
    [
      "an image reference",
      ["Look ![a pic][p] here. Then more.", "\n\n[p]: https://x.y/p.png\n"]
    ],
    ["a footnote reference", ["Note[^1] here. More.", "\n\n[^1]: The note.\n"]]
  ])(
    "speaks %s once whose definition arrives later",
    (_reference, fragments) => {
      expect(speakStreamed(fragments)).toEqual(
        speakFinished(fragments.join(""))
      )
    }
  )

  it("reads a link reference with no definition by its text", () => {
    expect(speakFinished("See [the docs][d] and [this][] now.")).toEqual([
      "See the docs and this now."
    ])
  })

  it("speaks the sentence before an image once while the image streams", () => {
    const fragments = ["Look ![a pi", "c](https://x.y/c.png) here. Then more."]
    expect(speakStreamed(fragments)).toEqual(speakFinished(fragments.join("")))
    expect(speakStreamed(fragments)).toEqual(["Look here.", "Then more."])
  })

  it("hands out every sentence still held when the reply finishes", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.push("Pay $3. Then go. Bye")).toEqual([])
    expect(buffer.finish()).toEqual(["Pay $3.", "Then go.", "Bye."])
  })

  it("hands out a text part's last sentence once the part ends", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.push("Let me check the weather.")).toEqual([])
    expect(buffer.endTextPart()).toEqual(["Let me check the weather."])
    expect(buffer.push("\n\nIt is sunny")).toEqual([])
    expect(buffer.finish()).toEqual(["It is sunny."])
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
