import { describe, expect, it } from "vitest"
import {
  markdownToPlainText,
  SpeechSentenceBuffer
} from "../../../../src/modules/voice/speechText"

describe("markdownToPlainText", () => {
  it("keeps plain paragraphs and ends them with a sentence boundary", () => {
    expect(markdownToPlainText("Hello there.")).toBe("Hello there.")
  })

  it("speaks a link by its text", () => {
    expect(
      markdownToPlainText("See [the docs](https://example.com/docs) now")
    ).toBe("See the docs now.")
  })

  it("drops a bare URL", () => {
    expect(markdownToPlainText("See https://example.com/docs now")).toBe(
      "See now."
    )
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
    const plain = markdownToPlainText(markdown)
    expect(plain).toContain("Before.")
    expect(plain).toContain("After.")
    expect(plain).not.toContain("secret")
    expect(plain).not.toContain("x^2")
    expect(plain).not.toContain("1 2")
  })

  it("keeps inline code as words", () => {
    expect(markdownToPlainText("Run `git status` first.")).toBe(
      "Run git status first."
    )
  })

  it("ends list items as sentences", () => {
    const plain = markdownToPlainText("- one\n- two\n- three")
    expect(plain).toBe("one.\ntwo.\nthree.")
  })

  it("flattens headings into their own sentences", () => {
    expect(markdownToPlainText("# Title\n\nBody text.")).toBe(
      "Title.\nBody text."
    )
  })
})

describe("SpeechSentenceBuffer", () => {
  it("emits a sentence only once it is complete", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(buffer.loadSnapshot("")).toEqual([])
    expect(buffer.push("Hello the")).toEqual([])
    expect(buffer.push("re. How are")).toEqual(["Hello there."])
    expect(buffer.push(" you?")).toEqual(["How are you?"])
  })

  it("replays the complete sentences of a loaded snapshot", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(buffer.loadSnapshot("One. Two. Thr")).toEqual(["One.", "Two."])
    expect(buffer.push("ee.")).toEqual(["Three."])
  })

  it("skips completed sentences when joining mid-reply", () => {
    const buffer = new SpeechSentenceBuffer("current")
    expect(buffer.loadSnapshot("One. Two. Thr")).toEqual([])
    expect(buffer.push("ee. Four.")).toEqual(["Three.", "Four."])
  })

  it("flushes the remainder on finish, however short", () => {
    const buffer = new SpeechSentenceBuffer("start")
    buffer.loadSnapshot("One. Trai")
    expect(buffer.finish()).toEqual(["Trai"])
    expect(buffer.finish()).toEqual([])
  })

  it("holds an unterminated code fence back until it closes", () => {
    const buffer = new SpeechSentenceBuffer("start")
    expect(buffer.push("Before.\n\n```\nconst x = 1;\n")).toEqual(["Before."])
    expect(buffer.push("const y = 2;\n```\nAfter.")).toEqual(["After."])
  })
})
