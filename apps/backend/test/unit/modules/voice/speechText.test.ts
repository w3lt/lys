import { describe, expect, it } from "vitest"
import {
  SpeechSentenceBuffer,
  buildVoiceTextPieces
} from "../../../../src/modules/voice/speechText"

/** Speaks a whole finished reply, as a `start` speech of a done reply does. */
function listFinishedSentences(markdown: string): string[] {
  const buffer = new SpeechSentenceBuffer("start")
  return [
    ...buffer.loadSnapshot({ text: markdown, lastTextPart: "closed" }),
    ...buffer.close()
  ]
}

/** Streams fragments into a `start` speech and collects what it hands out. */
function listStreamedSentences(fragments: readonly string[]): string[] {
  const buffer = new SpeechSentenceBuffer("start")
  const sentences = buffer.loadSnapshot({ text: "", lastTextPart: "open" })
  for (const fragment of fragments)
    sentences.push(...buffer.addFragment(fragment))
  return [...sentences, ...buffer.close()]
}

/**
 * Lists the words spoken, in order, without the punctuation and brackets
 * around them, which are not words.
 */
function listSpokenWords(sentences: readonly string[]): string[] {
  return sentences
    .join(" ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

describe("speech text", () => {
  it("ends a plain paragraph with a sentence boundary", () => {
    expect(listFinishedSentences("Hello there")).toEqual(["Hello there."])
  })

  it("speaks a link by its text", () => {
    expect(
      listFinishedSentences("See [the docs](https://example.com/docs) now")
    ).toEqual(["See the docs now."])
  })

  it("drops a bare URL", () => {
    expect(listFinishedSentences("See https://example.com/docs now")).toEqual([
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
    expect(listFinishedSentences(markdown)).toEqual(["Before.", "After."])
  })

  it("keeps bracketed numbers that are not citation markers", () => {
    expect(listFinishedSentences("Index [0] and [007] stay [2].")).toEqual([
      "Index [0] and [007] stay."
    ])
  })

  it("keeps a citation-shaped index in inline code", () => {
    expect(listFinishedSentences("Read `arr[1]` first [2].")).toEqual([
      "Read arr[1] first."
    ])
  })

  it("keeps inline code as words", () => {
    expect(listFinishedSentences("Run `git status` first.")).toEqual([
      "Run git status first."
    ])
  })

  it("ends list items as sentences", () => {
    expect(listFinishedSentences("- one\n- two\n- three")).toEqual([
      "one.",
      "two.",
      "three."
    ])
  })

  it("flattens headings into their own sentences", () => {
    expect(listFinishedSentences("# Title\n\nBody text.")).toEqual([
      "Title.",
      "Body text."
    ])
  })
})

describe("SpeechSentenceBuffer", () => {
  it("hands out a sentence once a later sentence follows it", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(buffer.loadSnapshot({ text: "", lastTextPart: "open" })).toEqual([])
    expect(buffer.addFragment("Hello the")).toEqual([])
    expect(buffer.addFragment("re. How are")).toEqual(["Hello there."])
    expect(buffer.addFragment(" you?")).toEqual([])
    expect(buffer.close()).toEqual(["How are you?"])
  })

  it("does not end a sentence at the period of a decimal number", () => {
    expect(
      listStreamedSentences(["It costs $3", ".", "50", " today.", " Bye."])
    ).toEqual(["It costs $3.50 today.", "Bye."])
  })

  it("does not end a sentence at the period of a version", () => {
    expect(
      listStreamedSentences(["Version 2", ".", "5 is out now.", " Bye."])
    ).toEqual(["Version 2.5 is out now.", "Bye."])
  })

  it("does not end a sentence at the period of an abbreviation", () => {
    expect(
      listStreamedSentences(["See Fig.", " 3 for details.", " Done."])
    ).toEqual(["See Fig. 3 for details.", "Done."])
  })

  it("hands out a sentence ended by a line break at once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.addFragment("First point.\n\n2")).toEqual(["First point."])
  })

  it("replays the final sentences of a snapshot still being written", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(
      buffer.loadSnapshot({ text: "One. Two. Thr", lastTextPart: "open" })
    ).toEqual(["One.", "Two."])
    expect(buffer.addFragment("ee. Four")).toEqual(["Three."])
  })

  it("joins a reply being written at the sentence being written", () => {
    const buffer = new SpeechSentenceBuffer("current")
    expect(
      buffer.loadSnapshot({ text: "One. Two. Thr", lastTextPart: "open" })
    ).toEqual([])
    expect(buffer.addFragment("ee. Four.")).toEqual(["Three."])
    expect(buffer.close()).toEqual(["Four."])
  })

  it.each([
    ["starts like a link definition", "[Note]: first sentence here."],
    ["holds a pipe", "A | B is first here."]
  ])(
    "joins a paragraph being written that %s at the sentence being written",
    (_shape, firstSentence) => {
      const buffer = new SpeechSentenceBuffer("current")
      expect(
        buffer.loadSnapshot({
          text: `Intro.\n\n${firstSentence} Second one is be`,
          lastTextPart: "open"
        })
      ).toEqual([])
      expect(buffer.addFragment("ing written. Third.")).toEqual([])
      expect(buffer.close()).toEqual(["Second one is being written.", "Third."])
    }
  )

  it.each([
    ["a `$`", "It costs $3 now."],
    ["an image", "See ![a chart][c] now."]
  ])(
    "joins a paragraph being written that holds %s before the sentence being written at that sentence",
    (_content, earlierSentence) => {
      const buffer = new SpeechSentenceBuffer("current")
      expect(
        buffer.loadSnapshot({
          text: `Intro here. ${earlierSentence} Then more words. And the`,
          lastTextPart: "open"
        })
      ).toEqual([])
      expect([...buffer.addFragment(" end. Bye."), ...buffer.close()]).toEqual([
        "And the end.",
        "Bye."
      ])
    }
  )

  it("joins at the next text part when the snapshot's text part ended", () => {
    const buffer = new SpeechSentenceBuffer("current")
    expect(
      buffer.loadSnapshot({
        text: "Done earlier. Let me check:",
        lastTextPart: "closed"
      })
    ).toEqual([])
    expect(buffer.addFragment("\n\nIt is sunny. ")).toEqual([])
    expect(buffer.close()).toEqual(["It is sunny."])
  })

  it("flushes the remainder on finish, however short, only once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "One. Trai", lastTextPart: "open" })
    expect(buffer.close()).toEqual(["Trai."])
    expect(buffer.close()).toEqual([])
  })

  it("holds an unterminated code fence back until it closes", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.addFragment("Before.\n\n```\nconst x = 1;\n")).toEqual([])
    expect(buffer.addFragment("const y = 2;\n```\nAfter. Next")).toEqual([
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
    expect(listStreamedSentences(fragments)).toEqual(
      listFinishedSentences(fragments.join(""))
    )
    expect(listStreamedSentences(fragments)).toEqual([
      "Here is the table:.",
      "That's the list.",
      "Anything else?"
    ])
  })

  it("speaks prose with a pipe once its paragraph ends", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.addFragment("Run a | b first. Then c")).toEqual([])
    expect(buffer.addFragment("\n\nDone")).toEqual([
      "Run a | b first.",
      "Then c."
    ])
  })

  it("speaks a sentence once when a later dollar sign turns it into math", () => {
    const fragments = ["It costs $3. Then", " $4 more. Bye."]
    expect(listStreamedSentences(fragments)).toEqual(
      listFinishedSentences(fragments.join(""))
    )
    expect(listStreamedSentences(fragments)).toEqual([
      "It costs 4 more.",
      "Bye."
    ])
  })

  it("speaks the sentences before an unpaired dollar sign at once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.addFragment("Intro here. Pay $3 today. Then go")).toEqual([
      "Intro here."
    ])
    expect(buffer.addFragment("\n\nDone")).toEqual([
      "Pay $3 today.",
      "Then go."
    ])
  })

  it("does not hold for a dollar sign in inline code", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.addFragment("Run `echo $HOME` now. Then stop")).toEqual([
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
      expect(listStreamedSentences(fragments)).toEqual(
        listFinishedSentences(fragments.join(""))
      )
    }
  )

  it("speaks what precedes a dollar sign held inside emphasis at once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.addFragment("Run `a` now. Then *pay $3*. Next")).toEqual([
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
      expect(listStreamedSentences(fragments)).toEqual(
        listFinishedSentences(fragments.join(""))
      )
    }
  )

  it.each([
    ["emphasis", "[*the* docs]", "See the docs now."],
    ["inline code", "[`npm` docs]", "See npm docs now."],
    ["nested brackets", "[a [b] c]", "See a [b] c now."],
    ["a bare URL", "[https://x.y]", "See now."]
  ])(
    "speaks a link reference whose text holds %s by its text, once, when its definition arrives after a later sentence",
    (_content, linkText, sentence) => {
      const fragments = [
        `Intro here. See ${linkText}[d] now.`,
        " More text here.",
        "\n\n[d]: https://x.y\n"
      ]
      expect(listStreamedSentences(fragments)).toEqual([
        "Intro here.",
        sentence,
        "More text here."
      ])
      expect(listFinishedSentences(fragments.join(""))).toEqual([
        "Intro here.",
        sentence,
        "More text here."
      ])
    }
  )

  it.each([
    [
      "a strong span",
      "Intro here. **Note!**[the docs][d] now.",
      ["Intro here.", "Note!", "the docs now.", "More text here."]
    ],
    [
      "an emphasis span",
      "Intro here. _Wow!_[see][d] the note.",
      ["Intro here.", "Wow!", "see the note.", "More text here."]
    ]
  ])(
    "reads a reference after %s ending in `!` as a link, not an image",
    (_span, sentence, expected) => {
      const fragments = [sentence, " More text here.", "\n\n[d]: https://x.y\n"]
      expect(listStreamedSentences(fragments)).toEqual(expected)
      expect(listFinishedSentences(fragments.join(""))).toEqual(expected)
      // Streamed by character, the `[` is text until it closes, and the
      // sentence before it may end with it; it is not a word.
      expect(
        listSpokenWords(listStreamedSentences([...fragments.join("")]))
      ).toEqual(listSpokenWords(expected))
    }
  )

  it.each([
    ["an escape", "\\!"],
    ["a character reference", "&#33;"]
  ])(
    "reads a reference after a `!` that %s writes as a link, not an image",
    (_writer, exclamationMark) => {
      const fragments = [
        `Intro here. See ${exclamationMark}[the docs][d] now.`,
        " More.\n\nNext paragraph here. And more.",
        "\n\n[d]: https://x.y\n"
      ]
      const expected = [
        "Intro here.",
        "See!",
        "the docs now.",
        "More.",
        "Next paragraph here.",
        "And more."
      ]
      expect(listStreamedSentences(fragments)).toEqual(expected)
      expect(listFinishedSentences(fragments.join(""))).toEqual(expected)
    }
  )

  it.each([
    ["an escape", "!\\[Enter]"],
    ["a character reference", "!&#91;Enter&#93;"]
  ])(
    "speaks a bracket that %s writes after a `!` as text",
    (_writer, written) => {
      expect(
        listSpokenWords(listFinishedSentences(`Press ${written} now. Then go.`))
      ).toEqual(["Press", "Enter", "now", "Then", "go"])
    }
  )

  it.each([
    ["escapes", "\\[1\\]"],
    ["character references", "&#91;1&#93;"]
  ])(
    "drops a citation marker whose brackets %s write, as the renderer shows it as a citation",
    (_writer, marker) => {
      const text = `See the docs ${marker} now. Bye.`
      const expected = ["See the docs now.", "Bye."]
      expect(listFinishedSentences(text)).toEqual(expected)
      expect(listStreamedSentences([...text])).toEqual(expected)
    }
  )

  it("drops a citation marker that is a reference's text once, before and after its definition arrives", () => {
    const fragments = [
      "Cite [1][] and [2][x] here.",
      " Ok.",
      "\n\n[1]: https://a.b\n[x]: https://c.d\n"
    ]
    const expected = ["Cite and here.", "Ok."]
    expect(listStreamedSentences(fragments)).toEqual(expected)
    expect(listFinishedSentences(fragments.join(""))).toEqual(expected)
  })

  it("keeps a citation-shaped index in inline code however its brackets are written", () => {
    expect(listFinishedSentences("Use `\\[1\\]` and `[2]` now.")).toEqual([
      "Use \\[1\\] and [2] now."
    ])
  })

  it("drops an image reference whose definition arrives later", () => {
    const fragments = [
      "Intro here. See ![a chart][c] now.",
      " More here.",
      "\n\n[c]: https://x.y/c.png\n"
    ]
    const expected = ["Intro here.", "See now.", "More here."]
    expect(listStreamedSentences(fragments)).toEqual(expected)
    expect(listFinishedSentences(fragments.join(""))).toEqual(expected)
  })

  it("speaks an indented line that directly follows a definition", () => {
    const text = "Hello there.\n\n[a]: http://x\n    Read me now.\n\nBye."
    const expected = ["Hello there.", "Read me now.", "Bye."]
    expect(listFinishedSentences(text)).toEqual(expected)
    expect(listStreamedSentences([...text])).toEqual(expected)
  })

  it("never speaks a definition whose title is still open", () => {
    const text =
      'Intro. Go.\n\n[a]: http://x "Hello. World is a title"\n\nAfter.'
    expect(listStreamedSentences([...text])).toEqual([
      "Intro.",
      "Go.",
      "After."
    ])
  })

  it("keeps a URL in inline code and drops a bare one", () => {
    expect(
      listFinishedSentences(
        "Run `curl https://x.y` now. Or visit www.x.y/docs."
      )
    ).toEqual(["Run curl https://x.y now.", "Or visit."])
  })

  it("speaks inline code that looks like a reference once while a hold is active", () => {
    const fragments = ["Use `[a][b]` today. Then $5 and more", " text. End."]
    expect(listStreamedSentences(fragments)).toEqual(
      listFinishedSentences(fragments.join(""))
    )
    expect(listStreamedSentences(fragments)[0]).toBe("Use [a][b] today.")
  })

  it("reads a link reference with no definition by its text", () => {
    expect(
      listFinishedSentences("See [the docs][d] and [this][] now.")
    ).toEqual(["See the docs and this now."])
  })

  it("speaks the sentence before an image once while the image streams", () => {
    const fragments = ["Look ![a pi", "c](https://x.y/c.png) here. Then more."]
    expect(listStreamedSentences(fragments)).toEqual(
      listFinishedSentences(fragments.join(""))
    )
    expect(listStreamedSentences(fragments)).toEqual([
      "Look here.",
      "Then more."
    ])
  })

  it("hands out every sentence still held when the reply finishes", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.addFragment("Pay $3. Then go. Bye")).toEqual([])
    expect(buffer.close()).toEqual(["Pay $3.", "Then go.", "Bye."])
  })

  it("hands out a text part's last sentence once the part ends", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ text: "", lastTextPart: "open" })
    expect(buffer.addFragment("Let me check the weather.")).toEqual([])
    expect(buffer.closeTextPart()).toEqual(["Let me check the weather."])
    expect(buffer.addFragment("\n\nIt is sunny")).toEqual([])
    expect(buffer.close()).toEqual(["It is sunny."])
  })
})

describe("buildVoiceTextPieces", () => {
  it("keeps a sentence that fits in one voice message", () => {
    expect(buildVoiceTextPieces("Short.")).toEqual(["Short."])
  })

  it("splits a long sentence at the last space before each limit", () => {
    const sentence = Array.from({ length: 1000 }, () => "word").join(" ")
    const pieces = buildVoiceTextPieces(sentence)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(2000)
      expect(piece).toBe(piece.trim())
    }
    expect(pieces.join(" ")).toBe(sentence)
  })

  it("cuts a run without spaces at the limit", () => {
    expect(
      buildVoiceTextPieces("x".repeat(4500)).map((piece) => piece.length)
    ).toEqual([2000, 2000, 500])
  })

  it("never splits a surrogate pair", () => {
    expect(buildVoiceTextPieces(`${"x".repeat(1999)}😀y`)).toEqual([
      "x".repeat(1999),
      "😀y"
    ])
  })
})
