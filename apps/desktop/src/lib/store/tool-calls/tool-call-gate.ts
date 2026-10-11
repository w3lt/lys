import type { ChatToolAnswer, ChatToolCall } from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"

import {
  getToolChoice,
  type ToolChoice,
  type ToolListState
} from "@/lib/store/tools"

import {
  ALLOWED_TOOL_ANSWER,
  parseBackendToolInput,
  type BackendToolInput,
  type BackendToolInputResult
} from "./backend-tools"
import {
  buildDeclinedToolResult,
  buildRunFailedToolResult,
  parseClientToolInput,
  TOOL_CALLS_OFF_CONTENT,
  TOOL_OFF_CONTENT,
  type ClientToolInput,
  type ClientToolInputResult
} from "./client-tools"

/** Validated input of one call, to a desktop tool or to a backend tool. */
export type ToolCallInput = ClientToolInput | BackendToolInput

/** Tool settings sampled when a call arrives. */
export type ToolCallSettings = {
  /** Lifecycle of the tool list, read before sampling. */
  readonly list: ToolListState
  /** Whether agents may call tools at all. */
  readonly areToolCallsOn: boolean
  /** Choices the person changed, keyed by tool name. */
  readonly toolChoices: ReadonlyMap<string, ToolChoice>
}

/** What the desktop does with one arriving call. */
export type ToolCallGate =
  | {
      /** The call is answered at once, without running a desktop tool. */
      readonly status: "answered"
      /**
       * Declined or run-failed answer; or, for a backend tool on Just run,
       * the answer that allows it.
       */
      readonly toolAnswer: ChatToolAnswer
    }
  | {
      /** The desktop tool runs at once. */
      readonly status: "run"
      /** Validated input. */
      readonly input: ClientToolInput
    }
  | {
      /** The person must allow or reject the call first. */
      readonly status: "ask"
      /** Definition of the called tool, for its access and runner tags. */
      readonly definition: ToolDefinition
      /** Validated input. */
      readonly input: ToolCallInput
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
 * explanation the model reads.
 */
function parseToolCallInput(
  call: ChatToolCall,
  definition: ToolDefinition
): ClientToolInputResult | BackendToolInputResult {
  switch (definition.runner) {
    case "client":
      return parseClientToolInput(call)
    case "backend":
      return parseBackendToolInput(call)
  }
}

/**
 * Builds the gate outcome of a call answered at once.
 *
 * @param toolAnswer - Answer sent without running a desktop tool.
 * @returns A frozen answered outcome.
 */
function buildAnsweredGate(toolAnswer: ChatToolAnswer): ToolCallGate {
  return Object.freeze({ status: "answered", toolAnswer })
}

/**
 * Builds the gate outcome of a call on Just run.
 *
 * @param input - Validated input of the call.
 * @returns `run` for a desktop tool, which then runs at once; for a backend
 * tool, the answer that allows it at once.
 */
function buildRunGate(input: ToolCallInput): ToolCallGate {
  switch (input.runner) {
    case "client":
      return Object.freeze({ status: "run", input })
    case "backend":
      return buildAnsweredGate(ALLOWED_TOOL_ANSWER)
  }
}

/**
 * Calculates what the desktop does with one arriving call.
 *
 * @param call - Call the backend sent.
 * @param settings - Tool settings sampled when the call arrived.
 * @returns `answered` when the tool is unknown, its arguments do not match,
 * or tool calls or the tool are switched off; otherwise the tool's approval
 * decides: Just run runs a desktop tool at once or allows a backend tool at
 * once, and Ask me waits for the person.
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
  const parsed = parseToolCallInput(call, listed.definition)
  if (parsed.status === "rejected") {
    return buildAnsweredGate(buildRunFailedToolResult(parsed.content))
  }
  if (!settings.areToolCallsOn) {
    return buildAnsweredGate(buildDeclinedToolResult(TOOL_CALLS_OFF_CONTENT))
  }

  const choice = getToolChoice(settings.toolChoices, listed.definition)
  if (!choice.isOn) {
    return buildAnsweredGate(buildDeclinedToolResult(TOOL_OFF_CONTENT))
  }

  switch (choice.approval) {
    case "run":
      return buildRunGate(parsed.input)
    case "ask":
      return Object.freeze({
        status: "ask",
        definition: listed.definition,
        input: parsed.input
      })
  }
}
