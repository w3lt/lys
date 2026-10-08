import type { SearchFilesFilter } from "@lys/protocol"

import type { ClientToolInput, ShownToolCall } from "@/lib/store/tool-calls"

/** Phrase naming what a search compares with its query, by target. */
const SEARCH_TARGET_PHRASES = Object.freeze({
  name: "file names",
  content: "file contents",
  nameAndContent: "file names and contents"
} satisfies Readonly<Record<SearchFilesFilter["target"], string>>)

/** Footer hint of a waiting call while the composer is empty. */
export const EMPTY_DRAFT_APPROVAL_HINT =
  "Or type below to say no, with a reason"

/** Footer hint of a waiting call while the composer holds text. */
export const DRAFT_APPROVAL_HINT = "↵ sends your message as her answer"

/**
 * Formats the plain sentence that says what a call will do.
 *
 * @param input - Validated input of the call.
 * @returns One sentence naming the action and its target; every current tool
 * only reads, so each sentence says that nothing is changed.
 */
export function formatToolCallSummary(input: ClientToolInput): string {
  switch (input.toolName) {
    case "read_text_file":
      return `Read ${input.input.path}. Nothing is changed.`
    case "search_files":
      return `Search ${SEARCH_TARGET_PHRASES[input.filter.target]} under ${input.filter.root} for “${input.filter.query}”. Nothing is changed.`
  }
}

/**
 * Formats the announcement of the call shown above the composer.
 *
 * @param toolCall - Call shown, or undefined when none is.
 * @returns A sentence while a call waits for the person, and an empty string
 * otherwise; a failed answer is announced by its own card.
 */
export function formatToolCallAnnouncement(
  toolCall: ShownToolCall | undefined
): string {
  return toolCall?.answer.status === "awaiting-person"
    ? `Lys is waiting for you to allow or reject ${toolCall.call.toolName}.`
    : ""
}
