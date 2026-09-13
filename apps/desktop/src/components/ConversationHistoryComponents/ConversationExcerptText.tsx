import type { ReactElement } from "react"

import type { ConversationExcerpt } from "@/lib/store/conversation-history"

import { buildExcerptSegments } from "./conversation-history-presentation"

/** Properties accepted by {@link ConversationExcerptText}. */
export type ConversationExcerptTextProps = {
  /** Bounded excerpt of the conversation, or null when no message has text. */
  readonly excerpt: ConversationExcerpt | null
  /** Parsed query of the displayed page; empty when not searching. */
  readonly highlightQuery: string
}

/**
 * Presents one conversation's excerpt with its search match highlighted.
 *
 * @remarks Primary category: presentational. The parent owns the excerpt and
 * the query; the component owns no state, effect, or resource. Text written by
 * the user is prefixed `you:`. The first case-insensitive occurrence of the
 * query is wrapped in a `mark` element; without a match, nothing is marked. A
 * missing excerpt renders `no messages`.
 * @param props - Excerpt and the query to highlight.
 * @returns The excerpt line of a history row.
 */
export default function ConversationExcerptText({
  excerpt,
  highlightQuery
}: ConversationExcerptTextProps): ReactElement {
  if (excerpt === null) {
    return <span className="conversation-history__excerpt">no messages</span>
  }

  const segments = buildExcerptSegments(excerpt.text, highlightQuery)
  const speakerPrefix = excerpt.speaker === "user" ? "you: " : ""

  return (
    <span className="conversation-history__excerpt">
      {speakerPrefix}
      {segments.before}
      {segments.match === "" ? null : <mark>{segments.match}</mark>}
      {segments.after}
    </span>
  )
}
