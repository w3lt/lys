import type { ChatToolApprovalAnswer, ChatToolCall } from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"

import type { ToolListState } from "@/lib/store/tools"

import {
  parseBackendToolInput,
  type BackendToolInput,
  type BackendToolInputResult
} from "./backend-tools"
import {
  formatRejectedToolCallContent,
  parseClientToolInput,
  type ClientToolInput,
  type ClientToolInputResult
} from "./client-tools"
import {
  parseMcpToolInput,
  type McpToolInput,
  type McpToolInputResult
} from "./mcp-tools"

/**
 * Validated input of one call: to a desktop tool, to a backend tool, or to a
 * tool of an MCP server.
 */
export type ToolCallInput = ClientToolInput | BackendToolInput | McpToolInput

/** How the desktop handles one approval prompt the backend sent. */
export type ToolApprovalPrompt =
  | {
      /** The person must allow or reject the call. */
      readonly status: "ask"
      /** Definition of the called tool, for its access and runner tags. */
      readonly definition: ToolDefinition
      /** Validated input the card describes. */
      readonly input: ToolCallInput
    }
  | {
      /** The desktop cannot show the call, so it answers at once. */
      readonly status: "rejected"
      /** Rejection whose `content` the model reads. */
      readonly toolAnswer: ChatToolApprovalAnswer
    }

/** Outcome of finding the listed definition of a called tool. */
type ListedToolDefinition =
  | {
      /** The desktop lists the tool. */
      readonly status: "found"
      /** Listed definition. */
      readonly definition: ToolDefinition
    }
  | {
      /** The desktop does not list the tool, or could not read its list. */
      readonly status: "missing"
      /** Explanation the model reads. */
      readonly content: string
    }

/** Answer that lets the backend go on with one call. */
export const ALLOWED_TOOL_APPROVAL: ChatToolApprovalAnswer = Object.freeze({
  status: "allowed"
})

/**
 * Builds the answer to a call the person rejected.
 *
 * @param note - Text the person typed as their reason; may be empty.
 * @returns A frozen declined answer whose content the model reads.
 */
export function buildDeclinedToolApproval(
  note: string
): ChatToolApprovalAnswer {
  return Object.freeze({
    status: "rejected",
    reason: "declined",
    content: formatRejectedToolCallContent(note)
  })
}

/**
 * Builds the prompt outcome of a call the desktop cannot show.
 *
 * @param content - Non-empty explanation the model reads.
 * @returns A frozen rejected outcome carrying a `showFailed` answer.
 */
function buildShowFailedPrompt(content: string): ToolApprovalPrompt {
  const toolAnswer: ChatToolApprovalAnswer = Object.freeze({
    status: "rejected",
    reason: "showFailed",
    content
  })
  return Object.freeze({ status: "rejected", toolAnswer })
}

/**
 * Finds the listed definition of a called tool.
 *
 * @param list - Lifecycle of the tool list.
 * @param toolName - Name of the called tool.
 * @returns `found`, or `missing` with the explanation the model reads.
 */
function findListedToolDefinition(
  list: ToolListState,
  toolName: string
): ListedToolDefinition {
  if (list.status !== "loaded") {
    return Object.freeze({
      status: "missing",
      content: "The desktop couldn't read its tool list."
    })
  }

  const definition = list.tools.find((tool) => tool.name === toolName)

  return definition === undefined
    ? Object.freeze({
        status: "missing",
        content: `The desktop has no tool named "${toolName}".`
      })
    : Object.freeze({ status: "found", definition })
}

/**
 * Parses one call's arguments by the side that runs its tool.
 *
 * @param call - Call the backend sent.
 * @param definition - Listed definition of the called tool.
 * @returns `parsed` with the validated input, or `rejected` with the
 * explanation the model reads; an MCP call is always parsed.
 */
function parseToolCallInput(
  call: ChatToolCall,
  definition: ToolDefinition
): ClientToolInputResult | BackendToolInputResult | McpToolInputResult {
  switch (definition.runner) {
    case "client":
      return parseClientToolInput(call)
    case "backend":
      return parseBackendToolInput(call)
    case "mcp":
      return parseMcpToolInput(definition)
  }
}

/**
 * Calculates how the desktop handles one approval prompt.
 *
 * @param call - Call the backend shows for approval.
 * @param list - Tool list the card's tags and description come from.
 * @returns `ask` with the tool's definition and the validated input the card
 * describes; or `rejected` with a `showFailed` answer when the list cannot be
 * read, has no such tool, or the desktop cannot describe the arguments, so
 * the person is never asked about a call they cannot see.
 * @remarks The backend decided that the call needs the person; the desktop
 * only decides whether it can show it.
 */
export function calculateToolApprovalPrompt(
  call: ChatToolCall,
  list: ToolListState
): ToolApprovalPrompt {
  const listed = findListedToolDefinition(list, call.toolName)
  if (listed.status === "missing") return buildShowFailedPrompt(listed.content)
  const parsed = parseToolCallInput(call, listed.definition)
  if (parsed.status === "rejected") return buildShowFailedPrompt(parsed.content)

  return Object.freeze({
    status: "ask",
    definition: listed.definition,
    input: parsed.input
  })
}
