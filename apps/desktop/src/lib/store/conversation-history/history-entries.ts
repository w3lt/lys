import type { ConversationPreview, ConversationSummary } from "@lys/protocol"

/** Author of the message an excerpt was taken from. */
export type ConversationExcerptSpeaker = ConversationPreview["role"]

/**
 * Bounded plain-text excerpt of one stored message, ready for display.
 *
 * @remarks Markdown markers are removed and whitespace is collapsed. `text`
 * starts with an ellipsis when earlier message text was omitted and ends with
 * one when later text was omitted.
 */
export type ConversationExcerpt = {
  /** Author of the excerpted message. */
  readonly speaker: ConversationExcerptSpeaker
  /** Non-empty, bounded excerpt text. */
  readonly text: string
}

/**
 * One listed conversation as the history panel presents it.
 *
 * @remarks Built once when its page arrives, so rendering never scans the
 * complete message text again. The entry is immutable; changes replace it.
 */
export type ConversationHistoryEntry = {
  /** UUIDv7 identity, also the stable list key. */
  readonly id: string
  /** Stored title, or null while no title has been generated or set. */
  readonly title: string | null
  /** ISO activity time that orders and groups the entry. */
  readonly updatedAt: string
  /** Excerpt shown beneath the title, or null when no message has content. */
  readonly excerpt: ConversationExcerpt | null
}

/** Code units of context kept before a search match inside its excerpt. */
const MATCH_EXCERPT_LEAD_LENGTH = 20

/** Maximum code units, before ellipses, of an excerpt around a search match. */
const MATCH_EXCERPT_LENGTH = 68

/** Maximum code units, before the ellipsis, of an excerpt without a match. */
const PREVIEW_EXCERPT_LENGTH = 58

/** Horizontal ellipsis marking text omitted from an excerpt. */
const EXCERPT_ELLIPSIS = "…"

/** Matches fenced code blocks, which an excerpt names instead of quoting. */
const FENCED_CODE_PATTERN = /```[\s\S]*?```/g

/** Matches Markdown markers that carry formatting rather than words. */
const MARKDOWN_MARKER_PATTERN = /[`*#>]/g

/** Matches runs of whitespace collapsed to one space. */
const WHITESPACE_RUN_PATTERN = /\s+/g

/** Matches characters with special meaning in a regular expression. */
const REGEXP_SYNTAX_PATTERN = /[.*+?^${}()|[\]\\/]/g

/** Location of one search match inside a text, in UTF-16 code units. */
export type TextMatch = {
  /** Inclusive start offset of the match. */
  readonly start: number
  /** Exclusive end offset of the match. */
  readonly end: number
}

/**
 * Parses the typed search text into the query sent and highlighted.
 *
 * @param rawQuery - Search text exactly as typed.
 * @returns The text without surrounding whitespace; an empty result means the
 * list is not being searched.
 */
export function parseConversationSearchQuery(rawQuery: string): string {
  return rawQuery.trim()
}

/**
 * Finds the first case-insensitive occurrence of a query in a text.
 *
 * @param text - Text searched for the query.
 * @param query - Non-empty parsed search query, matched literally.
 * @returns The match location in `text`, or undefined when absent.
 * @remarks Matching uses Unicode case-insensitive comparison and reports
 * offsets in the original text, so they remain valid for highlighting.
 */
export function findTextMatch(
  text: string,
  query: string
): TextMatch | undefined {
  const pattern = new RegExp(query.replace(REGEXP_SYNTAX_PATTERN, "\\$&"), "iu")
  const match = pattern.exec(text)
  if (match === null) return undefined

  return { start: match.index, end: match.index + match[0].length }
}

/**
 * Formats stored Markdown content as one line of plain text.
 *
 * @param content - Complete stored message content.
 * @returns Content with fenced code named `code`, formatting markers removed,
 * and whitespace collapsed and trimmed.
 */
function formatPlainMessageText(content: string): string {
  return content
    .replace(FENCED_CODE_PATTERN, " code ")
    .replace(MARKDOWN_MARKER_PATTERN, "")
    .replace(WHITESPACE_RUN_PATTERN, " ")
    .trim()
}

/**
 * Removes a surrogate half left at either edge by code-unit slicing.
 *
 * @param text - Text sliced at arbitrary code-unit offsets.
 * @returns The text without an unpaired leading low or trailing high surrogate.
 */
function removeBrokenSurrogates(text: string): string {
  return text.replace(/^[\uDC00-\uDFFF]/, "").replace(/[\uD800-\uDBFF]$/, "")
}

/**
 * Formats the excerpt window that surrounds a search match.
 *
 * @param plainText - One-line plain message text.
 * @param match - Location of the first match in `plainText`.
 * @returns A window starting shortly before the match, with ellipses where
 * text was omitted.
 */
function formatMatchExcerpt(plainText: string, match: TextMatch): string {
  const windowStart = Math.max(0, match.start - MATCH_EXCERPT_LEAD_LENGTH)
  const windowEnd = windowStart + MATCH_EXCERPT_LENGTH
  const windowText = removeBrokenSurrogates(
    plainText.slice(windowStart, windowEnd)
  ).trim()
  const leading = windowStart > 0 ? EXCERPT_ELLIPSIS : ""
  const trailing = windowEnd < plainText.length ? EXCERPT_ELLIPSIS : ""

  return `${leading}${windowText}${trailing}`
}

/**
 * Formats the excerpt taken from the start of a message.
 *
 * @param plainText - One-line plain message text.
 * @returns The opening text, ending with an ellipsis when text was omitted.
 */
function formatOpeningExcerpt(plainText: string): string {
  if (plainText.length <= PREVIEW_EXCERPT_LENGTH) return plainText

  const openingText = removeBrokenSurrogates(
    plainText.slice(0, PREVIEW_EXCERPT_LENGTH)
  ).trim()
  return `${openingText}${EXCERPT_ELLIPSIS}`
}

/**
 * Builds the bounded excerpt shown beneath one conversation title.
 *
 * @param preview - Message the backend selected for the listed conversation.
 * @param query - Parsed search query of the page; empty when not searching.
 * @returns An excerpt around the first match when the message contains the
 * query, otherwise its opening text; null when no displayable text remains.
 */
function buildConversationExcerpt(
  preview: ConversationPreview,
  query: string
): ConversationExcerpt | null {
  const plainText = formatPlainMessageText(preview.content)
  if (plainText === "") return null

  const match = query === "" ? undefined : findTextMatch(plainText, query)
  const text =
    match === undefined
      ? formatOpeningExcerpt(plainText)
      : formatMatchExcerpt(plainText, match)

  return Object.freeze({ speaker: preview.role, text })
}

/**
 * Builds the history entry for one listed conversation.
 *
 * @param summary - Validated conversation summary from one list page.
 * @param query - Parsed search query that produced the page.
 * @returns A frozen entry whose excerpt is bounded for rendering.
 */
export function buildConversationHistoryEntry(
  summary: ConversationSummary,
  query: string
): ConversationHistoryEntry {
  const excerpt =
    summary.preview === null
      ? null
      : buildConversationExcerpt(summary.preview, query)

  return Object.freeze({
    id: summary.id,
    title: summary.title,
    updatedAt: summary.updatedAt,
    excerpt
  })
}
