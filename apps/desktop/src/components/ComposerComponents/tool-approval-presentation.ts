import type { SearchFilesFilter } from "@lys/protocol"

import type { ShownToolCall, ToolCallInput } from "@/lib/store/tool-calls"

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
 * Formats the plain sentences that say what a call will do.
 *
 * @param input - Validated input of the call.
 * @returns The action and its target, then its effect: a tool that reads
 * this machine changes nothing, and a tool that reads the web names the host
 * it sends a request to, under the full URL.
 */
export function formatToolCallSummary(input: ToolCallInput): string {
  switch (input.toolName) {
    case "read_text_file":
      return `Read ${input.input.path}. Nothing is changed.`
    case "search_files":
      return `Search ${SEARCH_TARGET_PHRASES[input.filter.target]} under ${input.filter.root} for “${input.filter.query}”. Nothing is changed.`
    case "read_page":
      return `Read ${input.url}. Sends a request to ${input.host}.`
  }
}

/**
 * Formats the announcement of the call shown above the composer.
 *
 * @param toolCall - Call shown, or undefined when none is.
 * @returns While a call waits for the person, a sentence naming the tool and
 * what the call will do, so consecutive calls of one tool stay
 * distinguishable; otherwise an empty string, because a failed answer is
 * announced by its own card.
 */
export function formatToolCallAnnouncement(
  toolCall: ShownToolCall | undefined
): string {
  if (toolCall?.answer.status !== "awaiting-person") return ""

  const summary = formatToolCallSummary(toolCall.answer.input)
  return `Lys is waiting for you to allow or reject ${toolCall.call.toolName}: ${summary}`
}
