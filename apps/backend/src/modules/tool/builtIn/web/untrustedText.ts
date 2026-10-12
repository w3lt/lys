/**
 * Finds each run of three or more `<`, or of three or more `>`: the brackets
 * that open and close every content delimiter Lys writes around web text.
 */
const DELIMITER_BRACKET_RUN_PATTERN = /<{3,}|>{3,}/g

/** Finds each run of whitespace, line breaks included. */
const WHITESPACE_RUN_PATTERN = /\s+/g

/** Finds each control character; whitespace runs are replaced before it runs. */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/gu

/** Smallest UTF-16 code unit that opens a surrogate pair. */
const HIGH_SURROGATE_MINIMUM = 0xd800

/** Largest UTF-16 code unit that opens a surrogate pair. */
const HIGH_SURROGATE_MAXIMUM = 0xdbff

/** Character that ends an excerpt cut short. */
const EXCERPT_ELLIPSIS = "…"

/**
 * Sentence ending that tells the model how to cite web sources, shared by
 * every web tool so citations look the same whichever tool found the source.
 */
export const CITATION_MARKER_RULE =
  "a numbered marker such as [1], numbering sources in the order you first use them, and list each source you used under your answer as: [n] Title — URL."

/**
 * Formats untrusted web text so that it cannot hold a content delimiter, so
 * the text cannot close its own frame early and speak outside it.
 *
 * @param text - Untrusted text from a page or a search service.
 * @returns The text with every run of three or more `<` or `>` shortened to
 * two brackets. No delimiter can remain in any spelling, nested, spaced, or
 * in another case, and shortening a run never joins two others.
 */
export function formatDelimiterFreeText(text: string): string {
  return text.replace(DELIMITER_BRACKET_RUN_PATTERN, (run) => run.slice(0, 2))
}

/**
 * Cuts a text to at most a number of UTF-16 code units without splitting a
 * surrogate pair.
 *
 * @param text - Text to cut.
 * @param maximumLength - Most code units kept, inclusive; a positive integer.
 * @returns The text itself when it fits; otherwise its beginning, one code
 * unit shorter when the cut would end on the first half of a pair.
 */
function cutText(text: string, maximumLength: number): string {
  if (text.length <= maximumLength) return text
  const lastKept = text.charCodeAt(maximumLength - 1)
  const endsInsidePair =
    lastKept >= HIGH_SURROGATE_MINIMUM && lastKept <= HIGH_SURROGATE_MAXIMUM
  return text.slice(0, endsInsidePair ? maximumLength - 1 : maximumLength)
}

/**
 * Flattens untrusted web text onto one line.
 *
 * @param text - Untrusted text.
 * @returns The text with whitespace runs joined into single spaces, control
 * characters removed, trimmed, and unable to hold a delimiter. Control
 * characters are removed before the delimiter check, so one placed between
 * brackets cannot hide a delimiter.
 */
function flattenUntrustedText(text: string): string {
  const flattened = text
    .replace(WHITESPACE_RUN_PATTERN, " ")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .trim()
  return formatDelimiterFreeText(flattened)
}

/**
 * Formats untrusted web text shown on a single line, such as a title.
 *
 * @param text - Untrusted text.
 * @param maximumLength - Most UTF-16 code units of the result, inclusive; a
 * positive integer.
 * @returns The text with whitespace runs joined into single spaces, trimmed,
 * control characters removed, unable to hold a delimiter, and cut to the
 * limit without splitting a character.
 */
export function formatSingleLineText(
  text: string,
  maximumLength: number
): string {
  return cutText(flattenUntrustedText(text), maximumLength)
}

/**
 * Formats untrusted web text shown as a short excerpt on one line, such as a
 * search snippet.
 *
 * @param text - Untrusted text.
 * @param maximumLength - Most UTF-16 code units of the result, ellipsis
 * included, inclusive; an integer of at least 2.
 * @returns The flattened text as {@link formatSingleLineText} makes it; when
 * it is longer than the limit, its beginning followed by `…`, never splitting
 * a character. Empty when the text has no visible content.
 */
export function formatExcerptText(text: string, maximumLength: number): string {
  const flattened = flattenUntrustedText(text)
  if (flattened.length <= maximumLength) return flattened
  return cutText(flattened, maximumLength - 1) + EXCERPT_ELLIPSIS
}
