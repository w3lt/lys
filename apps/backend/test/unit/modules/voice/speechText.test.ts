import { unified } from "unified"
import { describe, expect, it, vi } from "vitest"
import {
  SpeechSentenceBuffer,
  buildVoiceTextPieces,
  type SpeechTextPart
} from "../../../../src/modules/voice/speechText"

/** Creates a text part of the reply's first round, or of the round given. */
function createTextPart(content: string, round = 0): SpeechTextPart {
  return { round, content }
}

/** Speaks a whole finished reply, as a `start` speech of a done reply does. */
function listFinishedSentences(markdown: string): string[] {
  const buffer = new SpeechSentenceBuffer("start")
  return [
    ...buffer.loadSnapshot({
      textParts: [createTextPart(markdown)],
      lastRoundText: "closed"
    }),
    ...buffer.closeRoundText()
  ]
}

/**
 * Streams one text part into a `start` speech, as the reply writes it: its
 * first fragment starts the part and the others extend it.
 */
function listStreamedSentences(fragments: readonly string[]): string[] {
  const buffer = new SpeechSentenceBuffer("start")
  const sentences = buffer.loadSnapshot({
    textParts: [],
    lastRoundText: "closed"
  })
  for (const [index, fragment] of fragments.entries())
    sentences.push(
      ...(index === 0
        ? buffer.addTextPart(createTextPart(fragment))
        : buffer.addFragment(fragment))
    )
  return [...sentences, ...buffer.closeRoundText()]
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

  it("drops emoji whole, with their skin tones and joiners", () => {
    const markdown = [
      "Great work 🎉 👍🏽 🇫🇷 👨‍👩‍👧 ❤️ 1️⃣.",
      "",
      "🎉🎉",
      "",
      "Run `echo ⭐` next."
    ].join("\n")
    expect(listFinishedSentences(markdown)).toEqual([
      "Great work.",
      "Run echo next."
    ])
  })

  it("drops text-style pictographs", () => {
    expect(
      listFinishedSentences(
        "Sunny ☀ today, fly ✈ there, love ❤ ♥ it, done ✔, warn ⚠, © ™ Lys."
      )
    ).toEqual(["Sunny today, fly there, love it, done, warn, Lys."])
  })

  it.each([
    ["Stop‼ Go now⁉ Fine.", ["Stop‼", "Go now⁉", "Fine."]],
    ["Stop‼️ Go now.", ["Stop‼", "Go now."]],
    ["Really⁉\n\nYes.", ["Really⁉", "Yes."]]
  ])(
    "reads punctuation that is also a pictograph as punctuation in %j",
    (markdown, sentences) => {
      expect(listFinishedSentences(markdown)).toEqual(sentences)
    }
  )

  it("speaks symbols that are not pictographs, and arrows, as written", () => {
    expect(
      listFinishedSentences("Done ✓ → ↔ ➡ next: 2 + 2 = 4, 50% off, ★.")
    ).toEqual(["Done ✓ → ↔ ➡ next: 2 + 2 = 4, 50% off, ★."])
  })

  it("reads an arrow in its emoji form as the arrow, but drops a keycap", () => {
    expect(
      listFinishedSentences("Go ➡️ there. Back ↔️ here. Press #️⃣ now.")
    ).toEqual(["Go ➡ there.", "Back ↔ here.", "Press now."])
  })

  it.each([
    ["Really‽\n\nYes.", ["Really‽", "Yes."]],
    ["日本語。\n\nYes.", ["日本語。", "Yes."]],
    ["Wow！\n\nOk.", ["Wow！", "Ok."]]
  ])(
    "adds no period to a block ending in a sentence terminator in %j",
    (markdown, sentences) => {
      expect(listFinishedSentences(markdown)).toEqual(sentences)
    }
  )
})

describe("SpeechSentenceBuffer", () => {
  it("hands out a sentence once a later sentence follows it", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(
      buffer.loadSnapshot({
        textParts: [createTextPart("")],
        lastRoundText: "open"
      })
    ).toEqual([])
    expect(buffer.addFragment("Hello the")).toEqual([])
    expect(buffer.addFragment("re. How are")).toEqual(["Hello there."])
    expect(buffer.addFragment(" you?")).toEqual([])
    expect(buffer.closeRoundText()).toEqual(["How are you?"])
  })

  it("hands out the sentences before one without letters once a later one holds a letter", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
    expect(buffer.addFragment("The answer is below. 42. ")).toEqual([])
    expect(buffer.addFragment("Then more")).toEqual([
      "The answer is below.",
      "42."
    ])
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
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
    expect(buffer.addFragment("First point.\n\n2")).toEqual(["First point."])
  })

  it("replays the final sentences of a snapshot still being written", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(
      buffer.loadSnapshot({
        textParts: [createTextPart("One. Two. Thr")],
        lastRoundText: "open"
      })
    ).toEqual(["One.", "Two."])
    expect(buffer.addFragment("ee. Four")).toEqual(["Three."])
  })

  it("joins a reply being written at the sentence being written", () => {
    const buffer = new SpeechSentenceBuffer("current")
    expect(
      buffer.loadSnapshot({
        textParts: [createTextPart("One. Two. Thr")],
        lastRoundText: "open"
      })
    ).toEqual([])
    expect(buffer.addFragment("ee. Four.")).toEqual(["Three."])
    expect(buffer.closeRoundText()).toEqual(["Four."])
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
          textParts: [
            createTextPart(`Intro.\n\n${firstSentence} Second one is be`)
          ],
          lastRoundText: "open"
        })
      ).toEqual([])
      expect(buffer.addFragment("ing written. Third.")).toEqual([])
      expect(buffer.closeRoundText()).toEqual([
        "Second one is being written.",
        "Third."
      ])
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
          textParts: [
            createTextPart(
              `Intro here. ${earlierSentence} Then more words. And the`
            )
          ],
          lastRoundText: "open"
        })
      ).toEqual([])
      expect([
        ...buffer.addFragment(" end. Bye."),
        ...buffer.closeRoundText()
      ]).toEqual(["And the end.", "Bye."])
    }
  )

  it("joins at the next round's text when a tool call ended the snapshot's last round's text", () => {
    const buffer = new SpeechSentenceBuffer("current")
    expect(
      buffer.loadSnapshot({
        textParts: [createTextPart("Done earlier. Let me check:")],
        lastRoundText: "closed"
      })
    ).toEqual([])
    expect(buffer.addTextPart(createTextPart("It is sunny. ", 1))).toEqual([])
    expect(buffer.closeRoundText()).toEqual(["It is sunny."])
  })

  it("flushes the remainder on finish, however short, only once", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({
      textParts: [createTextPart("One. Trai")],
      lastRoundText: "open"
    })
    expect(buffer.closeRoundText()).toEqual(["Trai."])
    expect(buffer.closeRoundText()).toEqual([])
  })

  it("holds an unterminated code fence back until it closes, not the text before it", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
    expect(buffer.addFragment("Before.\n\n```\nconst x = 1;\n")).toEqual([
      "Before."
    ])
    expect(buffer.addFragment("const y = 2;\n```\nAfter. Next")).toEqual([
      "After."
    ])
  })
})

describe("SpeechSentenceBuffer rounds", () => {
  /** A round that ends inside a code fence with a tool call, and the answer of the next round. */
  const parts = [
    createTextPart("Let me list the files:\n\n```bash\nls -la"),
    createTextPart("There are three files here. The largest is notes.txt.", 1)
  ]
  const spoken = [
    "Let me list the files:.",
    "There are three files here.",
    "The largest is notes.txt."
  ]

  it("ends what a stored round's text leaves open with the round", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect([
      ...buffer.loadSnapshot({ textParts: parts, lastRoundText: "closed" }),
      ...buffer.closeRoundText()
    ]).toEqual(spoken)
  })

  it("ends what a streamed round's text leaves open when a tool call ends the round", () => {
    const [first = createTextPart(""), second = createTextPart("")] = parts
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ textParts: [], lastRoundText: "closed" })
    expect([
      ...buffer.addTextPart(first),
      ...buffer.closeRoundText(),
      ...buffer.addTextPart(second),
      ...buffer.closeRoundText()
    ]).toEqual(spoken)
  })

  /** A round whose reasoning splits its text inside a code fence, as the renderer joins them. */
  const splitRound = [
    createTextPart("Look:\n\n```bash\nls"),
    createTextPart(" -la\n```\n\nDone here.")
  ]

  it("reads a stored round's text parts as one text", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect([
      ...buffer.loadSnapshot({
        textParts: splitRound,
        lastRoundText: "closed"
      }),
      ...buffer.closeRoundText()
    ]).toEqual(["Look:.", "Done here."])
  })

  it("reads a streamed round's text parts as one text", () => {
    const [first = createTextPart(""), second = createTextPart("")] = splitRound
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({ textParts: [], lastRoundText: "closed" })
    expect([
      ...buffer.addTextPart(first),
      ...buffer.addTextPart(second),
      ...buffer.closeRoundText()
    ]).toEqual(["Look:.", "Done here."])
  })

  it("joins a round being written at the sentence being written across its text parts", () => {
    const buffer = new SpeechSentenceBuffer("current")
    expect(
      buffer.loadSnapshot({
        textParts: [
          createTextPart("Before. "),
          createTextPart("Still the round. Thr")
        ],
        lastRoundText: "open"
      })
    ).toEqual([])
    expect([
      ...buffer.addFragment("ee. Four."),
      ...buffer.closeRoundText()
    ]).toEqual(["Three.", "Four."])
  })
})

describe("SpeechSentenceBuffer parsing cost", () => {
  it("parses no more than the blocks being written per fragment, however many paragraphs and items precede them", () => {
    const paragraph =
      "A sentence about the weather, with **bold** text. Another one follows here.\n\n"
    const item = "- An item that says something useful, with `code` in it.\n"
    const reply = `${paragraph.repeat(40)}${item.repeat(40)}The end.`
    const fragments = Array.from(
      { length: Math.ceil(reply.length / 4) },
      (_, index) => reply.slice(index * 4, index * 4 + 4)
    )
    const expected = listFinishedSentences(reply)
    const parse = vi.spyOn(Object.getPrototypeOf(unified()), "parse")
    try {
      expect(listStreamedSentences(fragments)).toEqual(expected)
      const parsedLengths = parse.mock.calls.map(
        ([text]) => String(text).length
      )
      expect(reply.length).toBeGreaterThan(5_000)
      expect(Math.max(...parsedLengths)).toBeLessThan(3 * paragraph.length)
    } finally {
      parse.mockRestore()
    }
  })
})

describe("SpeechSentenceBuffer structure changes", () => {
  it.each([
    [
      "a block a later `|` hides repeats a sentence of the block before",
      "Yes. That works.\n\nYes. Pipe it with a | b here.\nMore text."
    ],
    [
      "a table whose delimiter row is still being written interrupts a paragraph",
      "This is a long sentence that\nwraps here. And the rest\n|-x is a flag."
    ],
    ["a bare URL follows a sentence", "Delta! http://x.y/z - more"],
    ["a `www.` URL follows a sentence", "Delta! www.x.y - more"],
    ["a footnote reference follows a sentence", "Done! [^note] - more"],
    [
      "a capitalized footnote reference follows a sentence",
      "Done! [^Note], more"
    ],
    ["a footnote reference follows a period", "Done. [^No] - more"],
    ["an HTML tag follows a sentence", "Wow! <br> - more"],
    ["a closed HTML tag follows a sentence", "Run it! <br/>, then go"],
    ["an HTML comment follows a sentence", "Ok? <!-- c --> - x"],
    [
      "an HTML comment holding a `>` follows a sentence",
      "Ok? <!-- a > b --> - x"
    ],
    [
      "an HTML comment holding `->` follows a sentence",
      "Ok? <!-- a->b --> - x"
    ],
    [
      "a tag whose quoted attribute holds a `>` follows a sentence",
      'Wow! <img alt="a > b"> - more'
    ],
    [
      "a tag whose single-quoted attribute holds a `>` follows a sentence",
      "Run it! <br class='x>y'>, then go"
    ],
    [
      "a code span's closing backtick run grows into a longer run",
      "Type ` then see https://x.y/z. Then type ``` for a fence."
    ],
    [
      "a code span holding a tag loses its closing run",
      "Try `A <i>x</i>. B``. Done."
    ]
  ])(
    "speaks text streamed one character at a time as the whole text when %s",
    (_shape, markdown) => {
      expect(listStreamedSentences([...markdown])).toEqual(
        listFinishedSentences(markdown)
      )
    }
  )

  it.each([
    [
      "a list item right after a paragraph, before a quote",
      "Hi.\n- 42.\n> q",
      ["Hi.", "42.", "q."]
    ],
    [
      "a list item right after a paragraph, before an empty quote",
      "Hi.\n- 42.\n>",
      ["Hi.", "42."]
    ],
    [
      "a numbered item in a bullet item right after a paragraph",
      "Hi.\n- 2. x\n- b",
      ["Hi.", "2. x.", "b."]
    ],
    [
      "a bullet item of a number alone right after a paragraph",
      "Fine.\n- 1.\n\nNext.",
      ["Fine.", "1.", "Next."]
    ],
    [
      "a footnote reference a later mark cuts",
      "Done! [^x *y] - more",
      ["Done! - more."]
    ],
    [
      "a footnote reference with nested brackets",
      "Done! [^a [b] c] - more",
      ["Done! - more."]
    ]
  ])(
    "reads %s as the chat shows it, whole and streamed one character at a time",
    (_shape, markdown, sentences) => {
      expect(listFinishedSentences(markdown)).toEqual(sentences)
      expect(listStreamedSentences([...markdown])).toEqual(sentences)
    }
  )

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
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
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
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
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
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
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
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
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
    ["two escaped brackets", "\\[1\\]"],
    ["an escaped opening bracket", "\\[1]"],
    ["an escaped closing bracket", "[1\\]"],
    ["two character references", "&#91;1&#93;"],
    ["a character reference and a bracket", "&#91;1]"]
  ])(
    "drops a citation marker written with %s, as the renderer shows it as a citation",
    (_writer, marker) => {
      const text = `See the docs ${marker} now. Bye.`
      const expected = ["See the docs now.", "Bye."]
      expect(listFinishedSentences(text)).toEqual(expected)
      expect(listStreamedSentences([...text])).toEqual(expected)
    }
  )

  it.each([
    ["written as syntax", "[docs [1]](https://x)"],
    ["escaped", "[docs \\[1\\]](https://x)"]
  ])(
    "drops a citation marker %s in a link's text, as everywhere outside code",
    (_written, link) => {
      const text = `See ${link} now.`
      expect(listFinishedSentences(text)).toEqual(["See docs now."])
      expect(listStreamedSentences([...text])).toEqual(["See docs now."])
    }
  )

  it.each([
    {
      bracket: "an escaped opening bracket",
      fragments: [
        "See [see \\[1] now.",
        " More here.",
        "\n\n[see \\[1]: https://x\n"
      ],
      words: ["See", "see", "1", "now", "More", "here"]
    },
    {
      bracket: "an escaped closing bracket",
      fragments: ["See [1\\]] now.", " More here.", "\n\n[1\\]]: https://x\n"],
      words: ["See", "1", "now", "More", "here"]
    }
  ])(
    "speaks a reference whose text holds a citation marker with $bracket once, before and after its definition arrives",
    ({ fragments, words }) => {
      expect(listSpokenWords(listStreamedSentences(fragments))).toEqual(words)
      expect(
        listSpokenWords(listFinishedSentences(fragments.join("")))
      ).toEqual(words)
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

  it.each([
    ["strong text", ["Hello **world. S", "till bold** here. Next one."]],
    [
      "a mark that ends a text node",
      ["Hello *", "*world. Still bold*", "* here. Next one."]
    ],
    ["struck text", ["Hello ~~world. S", "till gone~~ here. Next one."]],
    ["inline code", ["Run `npm in", "stall. Then` go. Next one."]]
  ])(
    "speaks %s that spans a sentence end without its marks while streaming",
    (_shape, fragments) => {
      expect(listStreamedSentences(fragments)).toEqual(
        listFinishedSentences(fragments.join(""))
      )
      expect(
        listStreamedSentences(fragments).some((sentence) =>
          /[*~`]/.test(sentence)
        )
      ).toBe(false)
    }
  )

  it("does not take back a block whose next line may still continue it", () => {
    const fragments = ["- Item one\n*", "*bold** still item one. Next."]
    expect(listFinishedSentences(fragments.join(""))).toEqual([
      "Item one bold still item one.",
      "Next."
    ])
    expect(listStreamedSentences(fragments)).toEqual([
      "Item one bold still item one.",
      "Next."
    ])
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
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
    expect(buffer.addFragment("Pay $3. Then go. Bye")).toEqual([])
    expect(buffer.closeRoundText()).toEqual(["Pay $3.", "Then go.", "Bye."])
  })

  it("hands out a round's last sentence once its text ends", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot({
      textParts: [createTextPart("")],
      lastRoundText: "open"
    })
    expect(buffer.addFragment("Let me check the weather.")).toEqual([])
    expect(buffer.closeRoundText()).toEqual(["Let me check the weather."])
    expect(buffer.addTextPart(createTextPart("It is sunny", 1))).toEqual([])
    expect(buffer.closeRoundText()).toEqual(["It is sunny."])
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
