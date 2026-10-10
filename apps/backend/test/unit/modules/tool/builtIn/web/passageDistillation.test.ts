import { describe, expect, it } from "vitest"
import type { PageBlock } from "../../../../../../src/modules/tool/builtIn/web/pageExtraction"
import {
  calculatePagePassages,
  MAXIMUM_PASSAGE_LENGTH,
  MAXIMUM_SELECTED_PASSAGE_LENGTH,
  selectPagePassages,
  type PagePassage
} from "../../../../../../src/modules/tool/builtIn/web/passageDistillation"

/**
 * Builds a text block.
 *
 * @param text - Block text.
 * @returns The block.
 */
function buildTextBlock(text: string): PageBlock {
  return { kind: "text", text }
}

/**
 * Builds a heading block.
 *
 * @param text - Heading text.
 * @returns The block.
 */
function buildHeadingBlock(text: string): PageBlock {
  return { kind: "heading", text }
}

/**
 * Builds passages of filler text, each just under the passage limit.
 *
 * @param count - Number of passages.
 * @param topics - Words placed in the passage at their index.
 * @returns The passages, with `topics[i]` mentioned once in passage `i`.
 */
function buildFillerPassages(
  count: number,
  topics: Readonly<Record<number, string>> = {}
): readonly PagePassage[] {
  return Array.from({ length: count }, (_unused, index) => {
    const topic = topics[index] === undefined ? "" : ` ${topics[index]}`
    const filler = "Moths fly at night and rest by day. ".repeat(30)
    return {
      index,
      text: `Passage ${index}.${topic} ${filler}`.slice(0, 1_100)
    }
  })
}

/**
 * Calculates the length of passages shown together.
 *
 * @param passages - Passages shown.
 * @returns Their length with blank lines between them.
 */
function calculateShownLength(passages: readonly PagePassage[]): number {
  return passages.map((passage) => passage.text).join("\n\n").length
}

describe("calculatePagePassages", () => {
  it("joins blocks into passages while they fit and starts one at each heading", () => {
    const passages = calculatePagePassages([
      buildTextBlock("Intro."),
      buildTextBlock("More intro."),
      buildHeadingBlock("Life cycle"),
      buildTextBlock("Eggs hatch.")
    ])

    expect(passages).toEqual([
      { index: 0, text: "Intro.\n\nMore intro." },
      { index: 1, text: "Life cycle\n\nEggs hatch." }
    ])
  })

  it("starts a new passage when the next block would pass the limit", () => {
    const first = "a".repeat(700)
    const second = "b".repeat(700)

    expect(
      calculatePagePassages([buildTextBlock(first), buildTextBlock(second)])
    ).toEqual([
      { index: 0, text: first },
      { index: 1, text: second }
    ])
  })

  it("splits a block longer than a passage between its sentences", () => {
    const sentence = "Moths fly at night. "
    const block = sentence.repeat(120).trim()

    const passages = calculatePagePassages([buildTextBlock(block)])

    expect(passages.length).toBeGreaterThan(1)
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(MAXIMUM_PASSAGE_LENGTH)
      expect(passage.text.endsWith("night.")).toBe(true)
    }
    expect(passages.map((passage) => passage.text).join(" ")).toBe(block)
  })

  it("cuts a sentence longer than a passage", () => {
    const sentence = "x".repeat(MAXIMUM_PASSAGE_LENGTH * 2 + 10)

    const passages = calculatePagePassages([buildTextBlock(sentence)])

    expect(passages.map((passage) => passage.text.length)).toEqual([
      MAXIMUM_PASSAGE_LENGTH,
      MAXIMUM_PASSAGE_LENGTH,
      10
    ])
  })
})

describe("selectPagePassages", () => {
  it("selects every passage of a page that fits the limit", () => {
    const passages = buildFillerPassages(3)

    expect(selectPagePassages(passages, "anything")).toEqual({
      coverage: { kind: "complete" },
      passages,
      passageCount: 3
    })
  })

  it("selects the passages from the start of a long page without a focus", () => {
    const passages = buildFillerPassages(30)

    const selection = selectPagePassages(passages, undefined)

    expect(selection.coverage).toEqual({
      kind: "beginning",
      unmatchedFocus: undefined
    })
    expect(selection.passages.map((passage) => passage.index)).toEqual(
      Array.from(
        { length: selection.passages.length },
        (_unused, index) => index
      )
    )
    expect(calculateShownLength(selection.passages)).toBeLessThanOrEqual(
      MAXIMUM_SELECTED_PASSAGE_LENGTH
    )
    expect(selection.passageCount).toBe(30)
  })

  it("selects the passages that best match the focus, in page order", () => {
    const passages = buildFillerPassages(30, {
      7: "Caterpillars eat leaves; caterpillars grow fast.",
      22: "A caterpillar spins a cocoon."
    })

    const selection = selectPagePassages(passages, "caterpillars")

    expect(selection.coverage).toEqual({
      kind: "matching",
      focus: "caterpillars"
    })
    expect(selection.passages.map((passage) => passage.index)).toEqual([7])
  })

  it("ranks passages that mention more focus words higher", () => {
    const passages = buildFillerPassages(30, {
      4: "Silk moths spin silk.",
      18: "Silk and cocoon: the silk moth cocoon."
    })

    const selection = selectPagePassages(passages, "silk cocoon")

    expect(selection.passages.map((passage) => passage.index)).toEqual([4, 18])
  })

  it("matches a focus in a language written without spaces", () => {
    const passages = buildFillerPassages(30, { 12: "蛾は夜に飛ぶ昆虫です。" })

    const selection = selectPagePassages(passages, "昆虫")

    expect(selection.coverage.kind).toBe("matching")
    expect(selection.passages.map((passage) => passage.index)).toEqual([12])
  })

  it("falls back to the start and says so when the focus matches nothing", () => {
    const passages = buildFillerPassages(30)

    const selection = selectPagePassages(passages, "submarine")

    expect(selection.coverage).toEqual({
      kind: "beginning",
      unmatchedFocus: "submarine"
    })
    expect(selection.passages[0]?.index).toBe(0)
  })

  it("never shows more than the limit even when many passages match", () => {
    const topics = Object.fromEntries(
      Array.from({ length: 30 }, (_unused, index) => [index, "lantern"])
    )
    const passages = buildFillerPassages(30, topics)

    const selection = selectPagePassages(passages, "lantern")

    expect(calculateShownLength(selection.passages)).toBeLessThanOrEqual(
      MAXIMUM_SELECTED_PASSAGE_LENGTH
    )
    expect(selection.passages.length).toBeGreaterThan(1)
  })
})
