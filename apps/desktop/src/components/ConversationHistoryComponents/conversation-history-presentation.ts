import {
  type ConversationHistoryEntry,
  type ConversationHistoryListState,
  findTextMatch
} from "@/lib/store/conversation-history"

/** Calendar group an entry falls into, relative to when history opened. */
export type ConversationHistoryGroupLabel = "Today" | "Yesterday" | "Earlier"

/** Non-empty set of entries sharing one calendar group, in list order. */
export type ConversationHistoryGroup = {
  /** Visible group heading, unique among the groups built from one list. */
  readonly label: ConversationHistoryGroupLabel
  /** Entries in the group, in list order. */
  readonly entries: readonly ConversationHistoryEntry[]
}

/**
 * Transient interaction affecting at most one history row.
 *
 * @remarks Only one row can be edited or confirming deletion at a time;
 * starting either on another row replaces the current interaction.
 */
export type ConversationRowInteraction =
  | {
      /** No row is being edited or confirmed. */
      readonly kind: "none"
    }
  | {
      /** One row's title is being edited in place. */
      readonly kind: "editing-title"
      /** Conversation whose title is being edited. */
      readonly conversationId: string
    }
  | {
      /** One row is asking whether to delete its conversation. */
      readonly kind: "confirming-delete"
      /** Conversation whose deletion awaits confirmation. */
      readonly conversationId: string
    }

/** Excerpt text split around its highlighted search match. */
export type ExcerptSegments = {
  /** Text before the match, or the whole text when nothing matched. */
  readonly before: string
  /** Matched text, or empty when nothing matched. */
  readonly match: string
  /** Text after the match. */
  readonly after: string
}

/** Shared interaction for rows that are neither edited nor confirming. */
export const NO_ROW_INTERACTION: ConversationRowInteraction = Object.freeze({
  kind: "none"
})

/** Title shown for a conversation whose title has not been generated or set. */
const UNTITLED_CONVERSATION_TITLE = "Untitled"

/** Milliseconds in one minute, used for relative times within today. */
const MILLISECONDS_PER_MINUTE = 60_000

/** Milliseconds in one nominal day, used to round calendar-day distances. */
const MILLISECONDS_PER_DAY = 86_400_000

/** Exclusive upper bound, in days, for naming a weekday instead of a date. */
const WEEKDAY_LABEL_MAX_DAYS = 7

/** Lowercase weekday abbreviations indexed by `Date.prototype.getDay`. */
const WEEKDAY_LABELS = Object.freeze([
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat"
])

/**
 * Formats the title shown for one listed conversation.
 *
 * @param entry - Listed conversation.
 * @returns Its stored title, or a fixed placeholder while it has none.
 */
export function formatConversationTitle(
  entry: ConversationHistoryEntry
): string {
  return entry.title ?? UNTITLED_CONVERSATION_TITLE
}

/**
 * Calculates how many local calendar days separate two instants.
 *
 * @param timeMs - Epoch milliseconds of the earlier activity.
 * @param referenceTimeMs - Epoch milliseconds history is related to.
 * @returns Whole local calendar days from `timeMs` to `referenceTimeMs`; zero
 * or less for the same day or a later instant.
 */
function calculateCalendarDayDistance(
  timeMs: number,
  referenceTimeMs: number
): number {
  const time = new Date(timeMs)
  const reference = new Date(referenceTimeMs)
  const dayStartMs = new Date(
    time.getFullYear(),
    time.getMonth(),
    time.getDate()
  ).getTime()
  const referenceDayStartMs = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate()
  ).getTime()

  return Math.round((referenceDayStartMs - dayStartMs) / MILLISECONDS_PER_DAY)
}

/**
 * Selects the calendar group of one activity time.
 *
 * @param updatedAt - ISO activity time of an entry.
 * @param referenceTimeMs - Epoch milliseconds history is related to.
 * @returns Today for the reference day or later, Yesterday for the day
 * before, and Earlier otherwise, in local time.
 */
function calculateGroupLabel(
  updatedAt: string,
  referenceTimeMs: number
): ConversationHistoryGroupLabel {
  const dayDistance = calculateCalendarDayDistance(
    Date.parse(updatedAt),
    referenceTimeMs
  )
  if (dayDistance <= 0) return "Today"

  return dayDistance === 1 ? "Yesterday" : "Earlier"
}

/** Group headings in display order. */
const GROUP_LABELS: readonly ConversationHistoryGroupLabel[] = Object.freeze([
  "Today",
  "Yesterday",
  "Earlier"
])

/**
 * Builds the calendar groups shown for listed entries.
 *
 * @param entries - Listed entries, newest activity first.
 * @param referenceTimeMs - Epoch milliseconds history is related to.
 * @returns Today, Yesterday, and Earlier in that order, omitting empty ones;
 * each group keeps its entries in list order, so a label never repeats.
 */
export function buildConversationHistoryGroups(
  entries: readonly ConversationHistoryEntry[],
  referenceTimeMs: number
): readonly ConversationHistoryGroup[] {
  const labels = entries.map((entry) =>
    calculateGroupLabel(entry.updatedAt, referenceTimeMs)
  )
  const groups = GROUP_LABELS.map((label) =>
    Object.freeze({
      label,
      entries: Object.freeze(
        entries.filter((_entry, index) => labels[index] === label)
      )
    })
  )

  return Object.freeze(groups.filter((group) => group.entries.length > 0))
}

/**
 * Formats a local clock time as zero-padded hours and minutes.
 *
 * @param time - Instant to format in local time.
 * @returns Text such as `09:41`.
 */
function formatClockTime(time: Date): string {
  const hours = String(time.getHours()).padStart(2, "0")
  const minutes = String(time.getMinutes()).padStart(2, "0")

  return `${hours}:${minutes}`
}

/**
 * Formats the relative time of an activity within the reference day.
 *
 * @param timeMs - Epoch milliseconds of the activity.
 * @param referenceTimeMs - Epoch milliseconds history is related to.
 * @returns `now` under one minute, whole minutes under an hour, otherwise the
 * local clock time.
 */
function formatSameDayTime(timeMs: number, referenceTimeMs: number): string {
  const elapsedMinutes = Math.floor(
    (referenceTimeMs - timeMs) / MILLISECONDS_PER_MINUTE
  )
  if (elapsedMinutes < 1) return "now"
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`

  return formatClockTime(new Date(timeMs))
}

/**
 * Formats the compact time shown for one entry.
 *
 * @param updatedAt - ISO activity time of the entry.
 * @param referenceTimeMs - Epoch milliseconds history is related to.
 * @returns A relative time today, the clock time yesterday, a lowercase
 * weekday within the week, or month/day before that, all in local time.
 */
export function formatConversationTime(
  updatedAt: string,
  referenceTimeMs: number
): string {
  const timeMs = Date.parse(updatedAt)
  const dayDistance = calculateCalendarDayDistance(timeMs, referenceTimeMs)
  if (dayDistance <= 0) return formatSameDayTime(timeMs, referenceTimeMs)

  const time = new Date(timeMs)
  if (dayDistance === 1) return formatClockTime(time)
  if (dayDistance < WEEKDAY_LABEL_MAX_DAYS) return WEEKDAY_LABELS[time.getDay()]

  return `${time.getMonth() + 1}/${time.getDate()}`
}

/**
 * Builds the segments that highlight a search match inside an excerpt.
 *
 * @param text - Bounded excerpt text.
 * @param query - Parsed query of the displayed page; empty when not searching.
 * @returns The text split around its first case-insensitive match, or the
 * whole text before an empty match when nothing matches.
 */
export function buildExcerptSegments(
  text: string,
  query: string
): ExcerptSegments {
  const match = query === "" ? undefined : findTextMatch(text, query)
  if (match === undefined) return { before: text, match: "", after: "" }

  return {
    before: text.slice(0, match.start),
    match: text.slice(match.start, match.end),
    after: text.slice(match.end)
  }
}

/**
 * Formats the result count shown beside the search field.
 *
 * @param list - Current list state.
 * @returns Matches out of stored conversations while searching, the stored
 * count otherwise, `nothing kept` when none are stored, or empty text before
 * a page is displayed.
 */
export function formatConversationHistoryCount(
  list: ConversationHistoryListState
): string {
  if (list.status !== "loaded") return ""

  const { page } = list
  if (page.storedCount === 0) return "nothing kept"
  if (page.query !== "") return `${page.matchCount} of ${page.storedCount}`

  return `${page.storedCount} kept`
}

/**
 * Formats the keyboard hint shown at the foot of the history panel.
 *
 * @param list - Current list state.
 * @param rowInteraction - Row interaction currently in progress.
 * @param maximumTitleLength - Inclusive title limit named while editing.
 * @returns Guidance for the current interaction, or for browsing the list.
 */
export function formatConversationHistoryHint(
  list: ConversationHistoryListState,
  rowInteraction: ConversationRowInteraction,
  maximumTitleLength: number
): string {
  switch (rowInteraction.kind) {
    case "editing-title":
      return `enter saves · esc cancels · up to ${maximumTitleLength} characters`
    case "confirming-delete":
      return "deleting cannot be undone · esc keeps it"
    case "none":
      return list.status === "loaded" && list.page.storedCount === 0
        ? "anything you send is kept here"
        : "arrows move · enter continues · f2 renames"
  }
}
