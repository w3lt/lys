import type {
  ConversationMessageExcerpt,
  ConversationSummary
} from "@lys/protocol"

import type { ConversationHistoryPage } from "@/lib/store/conversation-history"

/** Day range a listed conversation belongs to. */
export type ConversationHistoryGroupLabel = "Today" | "Yesterday" | "Earlier"

/** One labelled day range of the conversation history list. */
export type ConversationHistoryGroup = {
  /** Day range shown as the group heading. */
  readonly label: ConversationHistoryGroupLabel
  /** Conversations in that range, keeping backend presentation order. */
  readonly conversations: readonly ConversationSummary[]
}

/** One excerpt split around the part matching the current search query. */
export type ConversationExcerptHighlight = {
  /** Excerpt text before the match. */
  readonly before: string
  /** Matched text, empty when the excerpt does not contain the query. */
  readonly match: string
  /** Excerpt text after the match. */
  readonly after: string
}

/** Title shown for a conversation the backend has not named yet. */
const UNTITLED_CONVERSATION_TITLE = "Untitled"

/** Prefix marking an excerpt taken from the reader's own message. */
const USER_EXCERPT_PREFIX = "you: "

/** Milliseconds in one day, used to measure whole-day distance. */
const MILLISECONDS_PER_DAY = 86_400_000

/** Days before a conversation time is shown as a calendar date. */
const MAXIMUM_WEEKDAY_AGE_DAYS = 7

/** Abbreviated weekday names indexed by `Date.prototype.getDay`. */
const WEEKDAY_NAMES: readonly string[] = Object.freeze([
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat"
])

/** Day ranges in the order the history list presents them. */
const GROUP_LABELS_BY_DAY_OFFSET: readonly ConversationHistoryGroupLabel[] =
  Object.freeze(["Today", "Yesterday", "Earlier"])

/**
 * Calculates the local calendar day of one instant as epoch milliseconds.
 *
 * @param timestamp - Instant to reduce to its local calendar day.
 * @returns Local midnight starting that day, as epoch milliseconds.
 */
function calculateLocalDayStart(timestamp: number): number {
  const date = new Date(timestamp)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * Calculates how many whole local days separate two instants.
 *
 * @param updatedAt - Instant a conversation was last updated.
 * @param listedAt - Instant the current list result began.
 * @returns Zero for the same day, one for the previous day, and so on.
 */
function calculateDayOffset(updatedAt: number, listedAt: number): number {
  const dayDistance =
    calculateLocalDayStart(listedAt) - calculateLocalDayStart(updatedAt)

  return Math.max(0, Math.round(dayDistance / MILLISECONDS_PER_DAY))
}

/**
 * Formats one clock time using a zero-padded 24-hour representation.
 *
 * @param date - Local date whose hours and minutes are shown.
 * @returns The time as `HH:MM`.
 */
function formatClockTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")

  return `${hours}:${minutes}`
}

/**
 * Formats how long ago a conversation was last updated.
 *
 * @param updatedAt - ISO instant the conversation was last updated.
 * @param listedAt - Instant the current list result began, in milliseconds.
 * @returns `now`, elapsed minutes, a clock time, a weekday, or a date.
 */
export function formatConversationUpdatedTime(
  updatedAt: string,
  listedAt: number
): string {
  const updatedTimestamp = Date.parse(updatedAt)
  const updatedDate = new Date(updatedTimestamp)
  const dayOffset = calculateDayOffset(updatedTimestamp, listedAt)

  if (dayOffset === 0) {
    const elapsedMinutes = Math.floor((listedAt - updatedTimestamp) / 60_000)
    if (elapsedMinutes < 1) return "now"
    if (elapsedMinutes < 60) return `${elapsedMinutes}m`

    return formatClockTime(updatedDate)
  }

  if (dayOffset === 1) return formatClockTime(updatedDate)
  if (dayOffset < MAXIMUM_WEEKDAY_AGE_DAYS) {
    return WEEKDAY_NAMES[updatedDate.getDay()] ?? formatClockTime(updatedDate)
  }

  return `${updatedDate.getMonth() + 1}/${updatedDate.getDate()}`
}

/**
 * Formats the display name of one listed conversation.
 *
 * @param title - Persisted title, or null before the backend names it.
 * @returns The persisted title, or the placeholder for an unnamed one.
 */
export function formatConversationTitle(title: string | null): string {
  return title ?? UNTITLED_CONVERSATION_TITLE
}

/**
 * Formats the excerpt line shown beneath one conversation title.
 *
 * @param excerpt - Message excerpt, or null when the conversation is empty.
 * @returns The excerpt with its author marked, or an empty-conversation note.
 */
export function formatConversationExcerpt(
  excerpt: ConversationMessageExcerpt | null
): string {
  if (excerpt === null) return "no messages"

  return excerpt.role === "user"
    ? `${USER_EXCERPT_PREFIX}${excerpt.text}`
    : excerpt.text
}

/**
 * Splits one excerpt around the first occurrence of the search query.
 *
 * @param excerptText - Excerpt line already formatted for display.
 * @param searchQuery - Current search text, which may be blank.
 * @returns The excerpt split into leading, matched, and trailing text.
 * @remarks Matching is case-insensitive and uses the same substring rule as
 * the backend search. `match` is empty when the query is blank or absent from
 * the excerpt, which happens when only the title matched.
 */
export function createConversationExcerptHighlight(
  excerptText: string,
  searchQuery: string
): ConversationExcerptHighlight {
  const trimmedQuery = searchQuery.trim()
  const matchStart =
    trimmedQuery === ""
      ? -1
      : excerptText.toLowerCase().indexOf(trimmedQuery.toLowerCase())

  if (matchStart < 0) {
    return Object.freeze({ before: excerptText, match: "", after: "" })
  }

  const matchEnd = matchStart + trimmedQuery.length

  return Object.freeze({
    before: excerptText.slice(0, matchStart),
    match: excerptText.slice(matchStart, matchEnd),
    after: excerptText.slice(matchEnd)
  })
}

/**
 * Groups listed conversations into the day ranges the panel presents.
 *
 * @param page - Conversations loaded so far and their reference instant.
 * @returns Non-empty day ranges in presentation order.
 * @remarks Input order is preserved inside every range, and a range with no
 * conversations is omitted rather than rendered empty.
 */
export function createConversationHistoryGroups(
  page: ConversationHistoryPage
): readonly ConversationHistoryGroup[] {
  const conversationsByLabel = new Map<
    ConversationHistoryGroupLabel,
    ConversationSummary[]
  >()

  for (const conversation of page.conversations) {
    const dayOffset = calculateDayOffset(
      Date.parse(conversation.updatedAt),
      page.listedAt
    )
    const label =
      GROUP_LABELS_BY_DAY_OFFSET[Math.min(dayOffset, 2)] ?? "Earlier"
    const grouped = conversationsByLabel.get(label)

    if (grouped === undefined) conversationsByLabel.set(label, [conversation])
    else grouped.push(conversation)
  }

  const groups = GROUP_LABELS_BY_DAY_OFFSET.flatMap((label) => {
    const conversations = conversationsByLabel.get(label)

    return conversations === undefined
      ? []
      : [Object.freeze({ label, conversations: Object.freeze(conversations) })]
  })

  return Object.freeze(groups)
}

/**
 * Formats the result count shown beside the search field.
 *
 * @param page - Conversations loaded so far and their result counts.
 * @param searchQuery - Current search text, which may be blank.
 * @returns Copy describing how many conversations the panel is reporting.
 */
export function formatConversationHistoryCount(
  page: ConversationHistoryPage,
  searchQuery: string
): string {
  if (page.total === 0) return "nothing kept"
  if (searchQuery.trim() === "") return `${page.total} kept`

  return `${page.matchCount} of ${page.total}`
}
