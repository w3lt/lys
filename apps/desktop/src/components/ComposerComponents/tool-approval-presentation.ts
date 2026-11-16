import {
  TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES,
  type SearchFilesFilter
} from "@lys/protocol"
import { DELEGATE_WORK_TOOL_NAME } from "@lys/share"

import type { ShownToolCall, ToolCallInput } from "@/lib/store/tool-calls"

/** Validated input of a `delegate_work` call. */
type DelegateWorkInput = Extract<
  ToolCallInput,
  { readonly toolName: typeof DELEGATE_WORK_TOOL_NAME }
>

/** The job of the shown conversation a shown call comes from. */
export type ToolCallJob = Readonly<{
  /** Name of the agent that works on the job. */
  agentName: string
  /** Title of the job's latest message. */
  title: string
}>

/** Footer hint of a waiting call while the composer is empty. */
export const EMPTY_DRAFT_APPROVAL_HINT =
  "Or type below to say no, with a reason"

/** Footer hint of a waiting call while the composer holds text. */
export const DRAFT_APPROVAL_HINT = "↵ sends your message as her answer"

/** Why a prompt that expired ended, and what became of its call. */
export const EXPIRED_TOOL_APPROVAL_SUMMARY = `No answer came within ${TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES} minutes, so the call did not run and the reply went on without it.`

/**
 * Formats what a `delegate_work` call will do.
 *
 * @param input - Validated input of the call.
 * @returns Whom the job goes to, by the agent code the model wrote, and
 * under which title, or for a continuation which job gets more work under
 * which new title; then the whole instructions, because they are all the
 * agent gets.
 */
function formatDelegateWorkSummary(input: DelegateWorkInput): string {
  const instructionsSentence = `It gets only these instructions: ${input.instructions}`
  if (input.jobNumber === undefined) {
    return `Give ${input.agentCode} the job “${input.title}”. ${instructionsSentence}`
  }
  return `Send ${input.agentCode} more work on job ${input.jobNumber}, now titled “${input.title}”. ${instructionsSentence}`
}

/**
 * Formats the plain sentences that say what a call will do.
 *
 * @param input - Validated input of the call.
 * @returns The action and its target, then its effect: a tool that reads
 * this machine changes nothing, a page read names the full URL of the page,
 * and a web search names where its full query goes. A location read names
 * where the location comes from, because the person typed it. A
 * `delegate_work` call names the agent and the job, then quotes all the
 * instructions the agent gets. An MCP call asks whether to run the tool, by
 * the name its server calls it, on that server: what it does depends on the
 * server, and the card shows its arguments, if it has any.
 */
export function formatToolCallSummary(input: ToolCallInput): string {
  /** Phrase naming what a search compares with its query, by target. */
  const searchTargetPhrases = Object.freeze({
    name: "file names",
    content: "file contents",
    nameAndContent: "file names and contents"
  } satisfies Readonly<Record<SearchFilesFilter["target"], string>>)

  if (input.runner === "mcp") {
    return `Run ${input.serverToolName} on the MCP server ${input.server}?`
  }
  switch (input.toolName) {
    case "read_text_file":
      return `Read ${input.input.path}. Nothing is changed.`
    case "search_files":
      return `Search ${searchTargetPhrases[input.filter.target]} under ${input.filter.root} for “${input.filter.query}”. Nothing is changed.`
    case "get_current_time":
      return "Read the date, time, and time zone of this machine. Nothing is changed."
    case "get_location":
      return "Read the location you saved in Settings → Profile. Nothing is changed."
    case "read_page":
      return `Read ${input.url}.`
    case "web_search":
      return `Search the web for “${input.query}”. Sends the query to Tavily (${input.host}).`
    case DELEGATE_WORK_TOOL_NAME:
      return formatDelegateWorkSummary(input)
  }
}

/**
 * Formats the announcement of the call shown above the composer.
 *
 * @param toolCall - Call shown, or undefined when none is.
 * @param agentName - Name of the agent whose reply made the call.
 * @returns While a call waits for the person, a sentence naming the agent,
 * the tool, and what the call will do, so consecutive calls of one tool stay
 * distinguishable; for a prompt that expired, a sentence naming the agent,
 * the tool, and why the call did not run; otherwise an empty string, because
 * a failed answer is announced by its own card.
 */
export function formatToolCallAnnouncement(
  toolCall: ShownToolCall | undefined,
  agentName: string
): string {
  switch (toolCall?.answer.status) {
    case "awaiting-person": {
      const summary = formatToolCallSummary(toolCall.answer.input)
      return `${agentName} is waiting for you to allow or reject ${toolCall.call.toolName}: ${summary}`
    }
    case "expired":
      return `${agentName}’s request to use ${toolCall.call.toolName} expired. ${EXPIRED_TOOL_APPROVAL_SUMMARY}`
    case "send-failed":
    case undefined:
      return ""
  }
}

/**
 * Formats the line that says which job of the shown conversation a shown
 * call comes from.
 *
 * @param job - The job, or undefined while the shown conversation does not
 * list it yet.
 * @returns The line naming the job's agent and title, or saying only that
 * the call comes from a job of this conversation.
 */
export function formatToolCallJobLine(job: ToolCallJob | undefined): string {
  return job === undefined
    ? "From a job of this conversation"
    : `From ${job.agentName}'s job: ${job.title}`
}
