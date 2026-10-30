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
 * this machine changes nothing, a page read names the full URL of the page,
 * and a web search names where its full query goes. A location read names
 * where the location comes from, because the person typed it. An MCP call
 * asks whether to run the tool, by the name its server calls it, on that
 * server: what it does depends on the server, and the card shows its
 * arguments, if it has any.
 */
export function formatToolCallSummary(input: ToolCallInput): string {
  if (input.runner === "mcp") {
    return `Run ${input.serverToolName} on the MCP server ${input.server}?`
  }
  switch (input.toolName) {
    case "read_text_file":
      return `Read ${input.input.path}. Nothing is changed.`
    case "search_files":
      return `Search ${SEARCH_TARGET_PHRASES[input.filter.target]} under ${input.filter.root} for “${input.filter.query}”. Nothing is changed.`
    case "get_current_time":
      return "Read the date, time, and time zone of this machine. Nothing is changed."
    case "get_location":
      return "Read the location you saved in Settings → Tools. Nothing is changed."
    case "read_page":
      return `Read ${input.url}.`
    case "web_search":
      return `Search the web for “${input.query}”. Sends the query to Tavily (${input.host}).`
  }
}

/**
 * Formats the announcement of the call shown above the composer.
 *
 * @param toolCall - Call shown, or undefined when none is.
 * @param agentName - Name of the agent whose reply made the call.
 * @returns While a call waits for the person, a sentence naming the agent,
 * the tool, and what the call will do, so consecutive calls of one tool stay
 * distinguishable; otherwise an empty string, because a failed answer is
 * announced by its own card.
 */
export function formatToolCallAnnouncement(
  toolCall: ShownToolCall | undefined,
  agentName: string
): string {
  if (toolCall?.answer.status !== "awaiting-person") return ""

  const summary = formatToolCallSummary(toolCall.answer.input)
  return `${agentName} is waiting for you to allow or reject ${toolCall.call.toolName}: ${summary}`
}
