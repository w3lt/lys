import {
  calculateRankingScores,
  listRankingWords
} from "../../../../utils/search/textRanking"
import type { PageBlock } from "./pageExtraction"

/** One passage of page text. */
export type PagePassage = Readonly<{
  /** Zero-based position of the passage in the page. */
  index: number
  /** Non-empty text; blocks are separated by blank lines. */
  text: string
}>

/** How much of a page the selected passages cover. */
export type PassageCoverage =
  | Readonly<{
      /** Every passage of the page is selected. */
      kind: "complete"
    }>
  | Readonly<{
      /** The passages that best match the focus are selected. */
      kind: "matching"
      /** Focus the passages were ranked against. */
      focus: string
    }>
  | Readonly<{
      /** Passages from the start of the page are selected. */
      kind: "beginning"
      /**
       * Focus that matched no passage, or undefined when the read named no
       * focus.
       */
      unmatchedFocus: string | undefined
    }>

/** Passages chosen from a page to show the model. */
export type PassageSelection = Readonly<{
  /** How much of the page the passages cover. */
  coverage: PassageCoverage
  /** Selected passages in page order; at least one. */
  passages: readonly PagePassage[]
  /** Number of passages the page has. */
  passageCount: number
}>

/** Most UTF-16 code units in one passage, inclusive. */
export const MAXIMUM_PASSAGE_LENGTH = 1_200

/**
 * Most UTF-16 code units of passage text shown to the model from one page,
 * inclusive, separators included.
 */
export const MAXIMUM_SELECTED_PASSAGE_LENGTH = 12_000

/** Text between two blocks of a passage. */
const BLOCK_SEPARATOR = "\n\n"

/** Splits text into sentences in any language. */
const SENTENCE_SEGMENTER = new Intl.Segmenter("und", {
  granularity: "sentence"
})

/**
 * Splits text longer than a passage into pieces that fit one.
 *
 * @param text - Block text.
 * @returns Pieces of at most {@link MAXIMUM_PASSAGE_LENGTH} code units, cut
 * between sentences where possible and inside a sentence that is longer
 * than a passage.
 */
function splitLongText(text: string): readonly string[] {
  if (text.length <= MAXIMUM_PASSAGE_LENGTH) return [text]
  const pieces: string[] = []
  let piece = ""
  for (const { segment } of SENTENCE_SEGMENTER.segment(text)) {
    for (
      let start = 0;
      start < segment.length;
      start += MAXIMUM_PASSAGE_LENGTH
    ) {
      const part = segment.slice(start, start + MAXIMUM_PASSAGE_LENGTH)
      if (piece.length + part.length > MAXIMUM_PASSAGE_LENGTH) {
        pieces.push(piece.trim())
        piece = ""
      }
      piece += part
    }
  }
  pieces.push(piece.trim())
  return pieces.filter((candidate) => candidate !== "")
}

/**
 * Splits a page's blocks into passages.
 *
 * @param blocks - Blocks of the page in page order.
 * @returns Passages in page order, each at most
 * {@link MAXIMUM_PASSAGE_LENGTH} code units. A heading starts a new passage,
 * so a passage never ends with the heading of the next one; consecutive
 * blocks share a passage while they fit.
 */
export function calculatePagePassages(
  blocks: readonly PageBlock[]
): readonly PagePassage[] {
  const texts: string[] = []
  let passageText = ""
  for (const block of blocks) {
    for (const piece of splitLongText(block.text)) {
      const joined =
        passageText === "" ? piece : passageText + BLOCK_SEPARATOR + piece
      const startsPassage =
        block.kind === "heading" || joined.length > MAXIMUM_PASSAGE_LENGTH
      if (startsPassage && passageText !== "") {
        texts.push(passageText)
        passageText = piece
      } else {
        passageText = joined
      }
    }
  }
  if (passageText !== "") texts.push(passageText)
  return Object.freeze(
    texts.map((text, index) => Object.freeze({ index, text }))
  )
}

/**
 * Calculates how much one passage adds to the selected text.
 *
 * @param passage - Passage being added.
 * @param selectedCount - Number of passages already selected.
 * @returns The passage's length, plus the separator before it unless it is
 * the first.
 */
function calculateAddedPassageLength(
  passage: PagePassage,
  selectedCount: number
): number {
  return (
    passage.text.length + (selectedCount === 0 ? 0 : BLOCK_SEPARATOR.length)
  )
}

/**
 * Selects passages in a given priority order until the length limit.
 *
 * @param passages - Passages in priority order.
 * @returns The passages that fit {@link MAXIMUM_SELECTED_PASSAGE_LENGTH},
 * separators included, in page order. A passage that does not fit is
 * skipped, and a later one that fits is still selected.
 */
function selectFittingPassages(
  passages: readonly PagePassage[]
): readonly PagePassage[] {
  const selected: PagePassage[] = []
  let selectedLength = 0
  for (const passage of passages) {
    const addedLength = calculateAddedPassageLength(passage, selected.length)
    if (selectedLength + addedLength > MAXIMUM_SELECTED_PASSAGE_LENGTH) continue
    selected.push(passage)
    selectedLength += addedLength
  }
  return Object.freeze(
    selected.toSorted((first, second) => first.index - second.index)
  )
}

/**
 * Selects the passages at the start of a page until the length limit.
 *
 * @param passages - Passages of the page in page order.
 * @returns The first passages that fit
 * {@link MAXIMUM_SELECTED_PASSAGE_LENGTH} together, separators included,
 * ending before the first passage that does not, so no passage before the
 * last one selected is left out.
 */
function selectLeadingPassages(
  passages: readonly PagePassage[]
): readonly PagePassage[] {
  const selected: PagePassage[] = []
  let selectedLength = 0
  for (const passage of passages) {
    const addedLength = calculateAddedPassageLength(passage, selected.length)
    if (selectedLength + addedLength > MAXIMUM_SELECTED_PASSAGE_LENGTH) break
    selected.push(passage)
    selectedLength += addedLength
  }
  return Object.freeze(selected)
}

/**
 * Calculates the length of every passage of a page shown together.
 *
 * @param passages - Passages of the page.
 * @returns Their summed length, separators included.
 */
function calculateCombinedLength(passages: readonly PagePassage[]): number {
  const separatorsLength =
    Math.max(passages.length - 1, 0) * BLOCK_SEPARATOR.length
  return passages.reduce(
    (length, passage) => length + passage.text.length,
    separatorsLength
  )
}

/**
 * Builds a selection of the passages from the start of the page.
 *
 * @param passages - Passages of the page in page order.
 * @param unmatchedFocus - Focus that matched nothing, or undefined without a
 * focus.
 * @returns The selection.
 */
function buildBeginningSelection(
  passages: readonly PagePassage[],
  unmatchedFocus: string | undefined
): PassageSelection {
  const coverage: PassageCoverage = Object.freeze({
    kind: "beginning",
    unmatchedFocus
  })
  return Object.freeze({
    coverage,
    passages: selectLeadingPassages(passages),
    passageCount: passages.length
  })
}

/** Coverage of a selection that holds every passage. */
const COMPLETE_COVERAGE: PassageCoverage = Object.freeze({ kind: "complete" })

/**
 * Ranks the passages that contain a focus word.
 *
 * @param passages - Passages of the page.
 * @param focusWords - Distinct words of the focus, at least one.
 * @returns The matching passages, best first, ties going to the earlier
 * passage; empty when none matches.
 */
function rankMatchingPassages(
  passages: readonly PagePassage[],
  focusWords: readonly string[]
): readonly PagePassage[] {
  const scores = calculateRankingScores(
    passages.map((passage) => passage.text),
    focusWords
  )
  /**
   * Finds the score of one passage.
   *
   * @param passage - Passage of the page.
   * @returns Its score; every passage has one.
   */
  const findScore = (passage: PagePassage): number => scores[passage.index] ?? 0
  return passages
    .filter((passage) => findScore(passage) > 0)
    .toSorted(
      (first, second) =>
        findScore(second) - findScore(first) || first.index - second.index
    )
}

/**
 * Selects the passages of a page to show the model.
 *
 * @param passages - Passages of the page in page order, at least one.
 * @param focus - What the model wants to learn from the page, or undefined
 * to read it from the start.
 * @returns Every passage when the page fits
 * {@link MAXIMUM_SELECTED_PASSAGE_LENGTH}; otherwise the passages that best
 * match the focus, or, without a focus or when it matches nothing, the
 * passages from the start; in every case in page order.
 * @remarks Passages are ranked with BM25 over their words, ties going to the
 * earlier passage. Words are found with the runtime's word segmentation, so
 * languages written without spaces are ranked too.
 */
export function selectPagePassages(
  passages: readonly PagePassage[],
  focus: string | undefined
): PassageSelection {
  if (calculateCombinedLength(passages) <= MAXIMUM_SELECTED_PASSAGE_LENGTH) {
    return Object.freeze({
      coverage: COMPLETE_COVERAGE,
      passages,
      passageCount: passages.length
    })
  }
  if (focus === undefined) return buildBeginningSelection(passages, undefined)
  const focusWords = [...new Set(listRankingWords(focus))]
  const ranked =
    focusWords.length === 0 ? [] : rankMatchingPassages(passages, focusWords)
  if (ranked.length === 0) return buildBeginningSelection(passages, focus)
  const coverage: PassageCoverage = Object.freeze({ kind: "matching", focus })
  return Object.freeze({
    coverage,
    passages: selectFittingPassages(ranked),
    passageCount: passages.length
  })
}
