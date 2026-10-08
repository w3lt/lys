import {
  readTextFileInputSchema,
  searchFilesFilterSchema,
  type ChatToolCall,
  type ChatToolResult,
  type ReadTextFileInput,
  type SearchFilesFilter
} from "@lys/protocol"

import type {
  ReadTextFileResult,
  SearchFilesResult
} from "@/lib/apis/tauri/tools"

/** Validated input of one call to a client tool the desktop can run. */
export type ClientToolInput =
  | {
      /** The read-text-file tool. */
      readonly toolName: "read_text_file"
      /** File the call reads. */
      readonly input: ReadTextFileInput
    }
  | {
      /** The search-files tool. */
      readonly toolName: "search_files"
      /** Root, query, target, and limits of the search. */
      readonly filter: SearchFilesFilter
    }

/** Outcome of checking one call's tool name and arguments. */
export type ClientToolInputResult =
  | {
      /** The desktop can run the call with this input. */
      readonly status: "parsed"
      /** Validated input. */
      readonly input: ClientToolInput
    }
  | {
      /** The desktop cannot run the call. */
      readonly status: "rejected"
      /** Explanation the model reads. */
      readonly content: string
    }

/** Desktop commands that run the client tools. */
export type ClientToolCommands = {
  /** Runs the read-text-file tool; see `readTextFile`. */
  readonly readTextFile: (
    input: ReadTextFileInput
  ) => Promise<ReadTextFileResult>
  /** Runs the search-files tool; see `findFiles`. */
  readonly findFiles: (filter: SearchFilesFilter) => Promise<SearchFilesResult>
}

/** Model-readable answer when the person switched tool calls off. */
export const TOOL_CALLS_OFF_CONTENT = "The person switched tool calls off."

/** Model-readable answer when the person switched the called tool off. */
export const TOOL_OFF_CONTENT = "The person switched this tool off."

/** Model-readable start of every answer to a call the person rejected. */
const DECLINED_CALL_CONTENT = "The person declined this call."

/** One argument problem found while checking a call. */
type ToolArgumentIssue = {
  /** Path of the argument within the call's arguments. */
  readonly path: readonly PropertyKey[]
  /** Validator message describing the problem. */
  readonly message: string
}

/**
 * Formats one argument problem.
 *
 * @param issue - Problem the tool's input schema reported.
 * @returns The argument's path, or `arguments` for the whole object, and the
 * problem.
 */
function formatArgumentIssue(issue: ToolArgumentIssue): string {
  const argumentPath = issue.path.map(String).join(".")

  return `${argumentPath === "" ? "arguments" : argumentPath}: ${issue.message}`
}

/**
 * Formats why a call's arguments do not match its tool.
 *
 * @param toolName - Name of the called tool.
 * @param issues - Problems the tool's input schema reported.
 * @returns A sentence naming each argument and its problem.
 */
function formatArgumentsMismatch(
  toolName: string,
  issues: readonly ToolArgumentIssue[]
): string {
  const problems = issues.map(formatArgumentIssue).join("; ")

  return `The arguments do not match ${toolName}: ${problems}.`
}

/**
 * Builds the rejected outcome of a call the desktop cannot run.
 *
 * @param content - Explanation the model reads.
 * @returns A frozen rejected outcome.
 */
function buildRejectedInput(content: string): ClientToolInputResult {
  return Object.freeze({ status: "rejected", content })
}

/**
 * Builds the parsed outcome of a call the desktop can run.
 *
 * @param input - Validated input.
 * @returns A frozen parsed outcome.
 */
function buildParsedInput(input: ClientToolInput): ClientToolInputResult {
  return Object.freeze({ status: "parsed", input })
}

/**
 * Parses the arguments of a read-text-file call.
 *
 * @param call - Call naming the read-text-file tool.
 * @returns `parsed` with the file to read, or `rejected` when the arguments
 * do not match the command.
 */
function parseReadTextFileInput(call: ChatToolCall): ClientToolInputResult {
  const parsed = readTextFileInputSchema.safeParse(call.arguments)
  if (!parsed.success) {
    return buildRejectedInput(
      formatArgumentsMismatch(call.toolName, parsed.error.issues)
    )
  }

  const input: ClientToolInput = Object.freeze({
    toolName: "read_text_file",
    input: parsed.data
  })
  return buildParsedInput(input)
}

/**
 * Parses the arguments of a search-files call.
 *
 * @param call - Call naming the search-files tool.
 * @returns `parsed` with the search filter, or `rejected` when the arguments
 * do not match the command.
 */
function parseSearchFilesInput(call: ChatToolCall): ClientToolInputResult {
  const parsed = searchFilesFilterSchema.safeParse(call.arguments)
  if (!parsed.success) {
    return buildRejectedInput(
      formatArgumentsMismatch(call.toolName, parsed.error.issues)
    )
  }

  const input: ClientToolInput = Object.freeze({
    toolName: "search_files",
    filter: parsed.data
  })
  return buildParsedInput(input)
}

/**
 * Parses one call into the input of a client tool the desktop can run.
 *
 * @param call - Call whose arguments the backend checked against the offered
 * definition.
 * @returns `parsed` with the validated input, or `rejected` when the desktop
 * has no runner for the tool or the arguments do not match its command.
 */
export function parseClientToolInput(
  call: ChatToolCall
): ClientToolInputResult {
  switch (call.toolName) {
    case "read_text_file":
      return parseReadTextFileInput(call)
    case "search_files":
      return parseSearchFilesInput(call)
    default:
      return buildRejectedInput(
        `The desktop has no tool named "${call.toolName}".`
      )
  }
}

/**
 * Builds the answer for a call that produced output.
 *
 * @param content - Output the model reads.
 * @returns A frozen succeeded result.
 */
function buildSucceededToolResult(content: string): ChatToolResult {
  return Object.freeze({ status: "succeeded", content })
}

/**
 * Builds the answer for a tool that ran and reported a declared failure.
 *
 * @param failure - Declared failure, sent to the model as JSON.
 * @returns A frozen tool-failed result.
 */
function buildToolFailedToolResult(failure: object): ChatToolResult {
  return Object.freeze({
    status: "failed",
    reason: "toolFailed",
    content: JSON.stringify(failure)
  })
}

/**
 * Builds the answer for a call the desktop could not run.
 *
 * @param content - Non-empty explanation the model reads.
 * @returns A frozen run-failed result.
 */
export function buildRunFailedToolResult(content: string): ChatToolResult {
  return Object.freeze({ status: "failed", reason: "runFailed", content })
}

/**
 * Builds the answer for a call that was declined, by the person or by a
 * switch.
 *
 * @param content - Non-empty explanation the model reads.
 * @returns A frozen declined result.
 */
export function buildDeclinedToolResult(content: string): ChatToolResult {
  return Object.freeze({ status: "failed", reason: "declined", content })
}

/**
 * Formats the answer to a call the person rejected.
 *
 * @param note - Text the person typed as their reason; may be empty.
 * @returns The declined sentence, followed by the trimmed reason when there
 * is one.
 */
export function formatRejectedToolCallContent(note: string): string {
  const reason = note.trim()

  return reason === ""
    ? DECLINED_CALL_CONTENT
    : `${DECLINED_CALL_CONTENT} They said: ${reason}`
}

/**
 * Builds the answer of a finished read.
 *
 * @param result - Outcome the read-text-file command returned.
 * @returns The file's text, or the declared failure as JSON.
 */
function buildReadTextFileToolResult(
  result: ReadTextFileResult
): ChatToolResult {
  switch (result.status) {
    case "succeeded":
      return buildSucceededToolResult(result.content)
    case "failed":
      return buildToolFailedToolResult(result.error)
  }
}

/**
 * Builds the answer of a finished search.
 *
 * @param result - Outcome the search-files command returned.
 * @returns The report as JSON, or the declared failure as JSON.
 */
function buildSearchFilesToolResult(result: SearchFilesResult): ChatToolResult {
  switch (result.status) {
    case "succeeded":
      return buildSucceededToolResult(JSON.stringify(result.report))
    case "failed":
      return buildToolFailedToolResult(result.error)
  }
}

/**
 * Formats a value thrown while running a tool.
 *
 * @param error - Untrusted thrown value.
 * @returns Its message, or a generic phrase when it carries none.
 */
function formatRunErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "it failed"
}

/**
 * Runs one validated call and builds its answer.
 *
 * @param input - Validated input selecting the tool.
 * @param commands - Desktop commands that run the tools.
 * @returns A promise that resolves with the answer once the command settles;
 * it never rejects. A command that throws becomes a `runFailed` answer. The
 * run cannot be cancelled.
 */
export async function runClientTool(
  input: ClientToolInput,
  commands: ClientToolCommands
): Promise<ChatToolResult> {
  try {
    switch (input.toolName) {
      case "read_text_file":
        return buildReadTextFileToolResult(
          await commands.readTextFile(input.input)
        )
      case "search_files":
        return buildSearchFilesToolResult(
          await commands.findFiles(input.filter)
        )
    }
  } catch (error) {
    return buildRunFailedToolResult(
      `${input.toolName} could not run: ${formatRunErrorMessage(error)}`
    )
  }
}
