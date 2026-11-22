/**
 * Places dictated text in the composer's draft: where the cursor was when
 * the dictation started, with a space on each side that needs one, and with
 * what was typed kept on both sides.
 */

/** Where a dictation writes: the typed text on each side of the cursor. */
export type DictationAnchor = Readonly<{
  /** Draft before the cursor. */
  before: string
  /** Draft after the cursor. */
  after: string
}>

/**
 * Typed text before the cursor that needs no space after it: none, or text
 * that ends with white space or an opening bracket.
 */
const JOINED_BEFORE_PATTERN = /(?:^|[\s([{])$/u

/**
 * Typed text after the cursor that needs no space before it: none, or text
 * that starts with white space, closing punctuation, or a closing bracket.
 */
const JOINED_AFTER_PATTERN = /^(?:$|[\s.,;:!?)\]}])/u

/**
 * Splits a draft at the cursor.
 *
 * @param draft - The composer's draft when the dictation starts.
 * @param cursor - Offset of the cursor in the draft, in UTF-16 code units; a
 * value outside the draft is moved to its nearest end.
 * @returns The typed text on each side of the cursor.
 */
export function buildDictationAnchor(
  draft: string,
  cursor: number
): DictationAnchor {
  const offset = Math.max(0, Math.min(draft.length, Math.trunc(cursor)))
  return { before: draft.slice(0, offset), after: draft.slice(offset) }
}

/**
 * Builds the draft that holds dictated text at a dictation's anchor.
 *
 * @param anchor - The typed text on each side of the cursor.
 * @param text - Everything dictated so far; surrounding white space is
 * dropped.
 * @returns The typed text before the cursor, the dictated text, and the
 * typed text after the cursor, with one space between the dictated text and
 * a neighbor that would otherwise touch a word; the typed text unchanged
 * while nothing is dictated.
 */
export function buildDictatedDraft(
  anchor: DictationAnchor,
  text: string
): string {
  const dictated = text.trim()
  if (dictated === "") return `${anchor.before}${anchor.after}`
  const leading = JOINED_BEFORE_PATTERN.test(anchor.before) ? "" : " "
  const trailing = JOINED_AFTER_PATTERN.test(anchor.after) ? "" : " "
  return `${anchor.before}${leading}${dictated}${trailing}${anchor.after}`
}
