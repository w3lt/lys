import type { ChatToolCall, ChatToolResult } from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"

import {
  getToolChoice,
  type ToolChoice,
  type ToolListState
} from "@/lib/store/tools"

import {
  buildDeclinedToolResult,
  buildRunFailedToolResult,
  parseClientToolInput,
  TOOL_CALLS_OFF_CONTENT,
  TOOL_OFF_CONTENT,
  type ClientToolInput
} from "./client-tools"

/** Tool settings sampled when a call arrives. */
export type ToolCallSettings = {
  /** Lifecycle of the client tool list, read before sampling. */
  readonly list: ToolListState
  /** Whether agents may call tools at all. */
  readonly areToolCallsOn: boolean
  /** Choices the person changed, keyed by tool name. */
  readonly toolChoices: ReadonlyMap<string, ToolChoice>
}

/** What the desktop does with one arriving call. */
export type ToolCallGate =
  | {
      /** The call is answered at once, without running a tool. */
      readonly status: "answered"
      /** Declined or run-failed answer. */
      readonly result: ChatToolResult
    }
  | {
      /** The tool runs at once. */
      readonly status: "run"
      /** Validated input. */
      readonly input: ClientToolInput
    }
  | {
      /** The person must allow or reject the call first. */
      readonly status: "ask"
      /** Definition of the called tool, for its access tag. */
      readonly definition: ToolDefinition
      /** Validated input. */
      readonly input: ClientToolInput
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

/**
 * Finds the listed definition of a called tool.
 *
 * @param list - Lifecycle of the client tool list.
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
 * Builds the gate outcome of a call answered at once.
 *
 * @param result - Declined or run-failed answer.
 * @returns A frozen answered outcome.
 */
function buildAnsweredGate(result: ChatToolResult): ToolCallGate {
  return Object.freeze({ status: "answered", result })
}

/**
 * Calculates what the desktop does with one arriving call.
 *
 * @param call - Call the backend sent.
 * @param settings - Tool settings sampled when the call arrived.
 * @returns `answered` when the tool is unknown, its arguments do not match,
 * or tool calls or the tool are switched off; otherwise `run` or `ask`,
 * following the tool's approval.
 * @remarks The settings are read once per call, so switching a tool off
 * affects every call that arrives afterwards, including later calls of a
 * reply already running.
 */
export function calculateToolCallGate(
  call: ChatToolCall,
  settings: ToolCallSettings
): ToolCallGate {
  const listed = findListedToolDefinition(settings.list, call.toolName)
  if (listed.status === "missing") {
    return buildAnsweredGate(buildRunFailedToolResult(listed.content))
  }
  const parsed = parseClientToolInput(call)
  if (parsed.status === "rejected") {
    return buildAnsweredGate(buildRunFailedToolResult(parsed.content))
  }
  if (!settings.areToolCallsOn) {
    return buildAnsweredGate(buildDeclinedToolResult(TOOL_CALLS_OFF_CONTENT))
  }

  const choice = getToolChoice(settings.toolChoices, call.toolName)
  if (!choice.isOn) {
    return buildAnsweredGate(buildDeclinedToolResult(TOOL_OFF_CONTENT))
  }

  switch (choice.approval) {
    case "run":
      return Object.freeze({ status: "run", input: parsed.input })
    case "ask":
      return Object.freeze({
        status: "ask",
        definition: listed.definition,
        input: parsed.input
      })
  }
}
