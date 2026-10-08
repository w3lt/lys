import {
  buildToolFunctionFormat,
  type ToolAccess,
  type ToolArgumentDefinition,
  type ToolDefinition,
  type ToolGroup
} from "@lys/share"

import {
  estimateTextTokens,
  formatTokenCount
} from "@/components/ComposerComponents/composer-context"
import type { ToolModelSupport } from "@/lib/models/tool-model-support"
import {
  CALLS_PER_REPLY_OPTIONS,
  TOOL_APPROVALS,
  getToolChoice,
  type CallsPerReply,
  type ToolApproval,
  type ToolChoice
} from "@/lib/store/tools"

/** Tone of the tool-calls status dot. */
export type ToolCallsTone = "neutral" | "active" | "warning"

/** Facts the tool-calls status line describes. */
export type ToolCallsSummary = {
  /** Whether agents may call tools at all. */
  readonly areToolCallsOn: boolean
  /** Whether the loaded model can be offered tools. */
  readonly support: ToolModelSupport
  /** Number of tools switched on. */
  readonly offeredToolCount: number
  /** Estimated tokens the switched-on tools add to each request. */
  readonly offeredTokenCount: number
}

/** Tools listed under one group heading, in list order. */
export type ToolGroupListing = {
  /** Group the tools belong to. */
  readonly group: ToolGroup
  /** Tools of the group, at least one, in list order. */
  readonly tools: readonly ToolDefinition[]
}

/** Tools switched on and what they add to each request. */
export type OfferedToolTotals = {
  /** Number of tools switched on. */
  readonly offeredToolCount: number
  /** Estimated tokens the switched-on tools add to each request. */
  readonly offeredTokenCount: number
}

/** Lowercase heading text of every tool group; a new group must add one. */
const TOOL_GROUP_LABELS = Object.freeze({
  files: "files"
} satisfies Readonly<Record<ToolGroup, string>>)

/** Lowercase badge text of every access level; a new level must add one. */
const TOOL_ACCESS_LABELS = Object.freeze({
  reads: "reads"
} satisfies Readonly<Record<ToolAccess, string>>)

/**
 * Calculates an estimate of the tokens a tool adds to each request it is
 * offered in.
 *
 * @param tool - Tool definition.
 * @returns The estimate for the function tool the model receives, which
 * varies with the model's tokenizer.
 */
export function calculateToolTokenEstimate(tool: ToolDefinition): number {
  return estimateTextTokens(JSON.stringify(buildToolFunctionFormat(tool)))
}

/**
 * Calculates how many tools are switched on and what they add to a request.
 *
 * @param tools - Every listed tool.
 * @param toolChoices - Choices the person changed, keyed by tool name.
 * @returns The count and summed token estimate of the tools switched on.
 */
export function calculateOfferedToolTotals(
  tools: readonly ToolDefinition[],
  toolChoices: ReadonlyMap<string, ToolChoice>
): OfferedToolTotals {
  const offeredTools = tools.filter(
    (tool) => getToolChoice(toolChoices, tool.name).isOn
  )
  const offeredTokenCount = offeredTools.reduce(
    (tokenCount, tool) => tokenCount + calculateToolTokenEstimate(tool),
    0
  )

  return Object.freeze({
    offeredToolCount: offeredTools.length,
    offeredTokenCount
  })
}

/**
 * Formats a token estimate for a tool row or the status line.
 *
 * @param tokenCount - Estimated tokens.
 * @returns A label such as `~108 tok`; the `~` marks an estimate.
 */
export function formatToolTokenEstimate(tokenCount: number): string {
  return `~${formatTokenCount(tokenCount)} tok`
}

/**
 * Formats the line under the tool-calls heading.
 *
 * @param summary - Switch state, model support, and the switched-on tools.
 * @returns What agents are offered: nothing while tool calls are off or the
 * model was not trained for them, and otherwise the count and token estimate,
 * after the model's key when a model is loaded.
 */
export function formatToolCallsStatus(summary: ToolCallsSummary): string {
  if (!summary.areToolCallsOn) {
    return "agents answer from the prompt alone · nothing is offered"
  }

  const offer = `${summary.offeredToolCount} offered · ${formatToolTokenEstimate(summary.offeredTokenCount)} per request`
  switch (summary.support.status) {
    case "unknown":
      return offer
    case "trained":
      return `${summary.support.modelKey} · ${offer}`
    case "untrained":
      return `${summary.support.modelKey} isn't trained for tool calls · nothing is offered`
  }
}

/**
 * Calculates the tone of the tool-calls status dot.
 *
 * @param areToolCallsOn - Whether agents may call tools.
 * @param support - Whether the loaded model can be offered tools.
 * @returns `neutral` while tool calls are off, `warning` while the loaded
 * model was not trained for them, and `active` otherwise.
 */
export function calculateToolCallsTone(
  areToolCallsOn: boolean,
  support: ToolModelSupport
): ToolCallsTone {
  if (!areToolCallsOn) return "neutral"

  return support.status === "untrained" ? "warning" : "active"
}

/**
 * Builds the group listings of the tools, keeping list order.
 *
 * @param tools - Every listed tool, in list order.
 * @returns One frozen listing per group, in the order each group first
 * appears, with its tools in list order.
 */
export function buildToolGroups(
  tools: readonly ToolDefinition[]
): readonly ToolGroupListing[] {
  const toolsByGroup = new Map<ToolGroup, ToolDefinition[]>()
  for (const tool of tools) {
    const groupTools = toolsByGroup.get(tool.group)
    if (groupTools === undefined) toolsByGroup.set(tool.group, [tool])
    else groupTools.push(tool)
  }

  return Object.freeze(
    [...toolsByGroup].map(([group, groupTools]) =>
      Object.freeze({ group, tools: Object.freeze(groupTools) })
    )
  )
}

/**
 * Formats the heading of a tool group.
 *
 * @param group - Group of the listed tools.
 * @returns The group's lowercase heading text.
 */
export function formatToolGroupLabel(group: ToolGroup): string {
  return TOOL_GROUP_LABELS[group]
}

/**
 * Formats the count beside a tool group's heading.
 *
 * @param onToolCount - Number of the group's tools switched on.
 * @param toolCount - Number of the group's tools.
 * @returns A label such as `1 of 2 on`.
 */
export function formatToolGroupCount(
  onToolCount: number,
  toolCount: number
): string {
  return `${onToolCount} of ${toolCount} on`
}

/**
 * Formats the badge that says what a tool does with the machine.
 *
 * @param access - Access level of the tool.
 * @returns The badge's lowercase text.
 */
export function formatToolAccessLabel(access: ToolAccess): string {
  return TOOL_ACCESS_LABELS[access]
}

/**
 * Formats the type of one argument.
 *
 * @param argument - Argument definition.
 * @returns The JSON type, or `enum · N` for an enum with N values.
 */
export function formatToolArgumentType(
  argument: ToolArgumentDefinition
): string {
  switch (argument.type) {
    case "enum":
      return `enum · ${argument.values.length}`
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return argument.type
  }
}

/**
 * Formats whether a model must supply one argument.
 *
 * @param isRequired - Whether the argument is required.
 * @returns `required` or `optional`.
 */
export function formatToolArgumentRequirement(isRequired: boolean): string {
  return isRequired ? "required" : "optional"
}

/**
 * Formats how many of a tool's arguments are required and optional.
 *
 * @param toolArguments - Arguments of one tool.
 * @returns `none` without arguments, otherwise the non-zero counts such as
 * `3 required · 2 optional`.
 */
export function formatToolArgumentCounts(
  toolArguments: readonly ToolArgumentDefinition[]
): string {
  if (toolArguments.length === 0) return "none"

  const requiredCount = toolArguments.filter(
    (argument) => argument.required
  ).length
  const optionalCount = toolArguments.length - requiredCount
  const counts: string[] = []
  if (requiredCount > 0) counts.push(`${requiredCount} required`)
  if (optionalCount > 0) counts.push(`${optionalCount} optional`)

  return counts.join(" · ")
}

/**
 * Formats the label of one approval choice.
 *
 * @param approval - When a tool runs once the model asks for it.
 * @returns `Ask me` or `Just run`.
 */
export function formatToolApprovalLabel(approval: ToolApproval): string {
  switch (approval) {
    case "ask":
      return "Ask me"
    case "run":
      return "Just run"
  }
}

/**
 * Formats what happens before a tool runs under one approval.
 *
 * @param approval - When the tool runs once the model asks for it.
 * @returns A sentence describing the approval.
 */
export function formatToolApprovalNote(approval: ToolApproval): string {
  switch (approval) {
    case "ask":
      return "You see the call and its arguments. Nothing happens until you say yes."
    case "run":
      return "Runs the moment the model asks for it."
  }
}

/**
 * Finds the number of calls per reply a toggle group selected.
 *
 * @param groupValue - Pressed item values the toggle group reports.
 * @returns The selected number, or `undefined` when the group reports no
 * offered number, as when the pressed item is pressed again.
 */
export function findCallsPerReply(
  groupValue: readonly string[]
): CallsPerReply | undefined {
  return CALLS_PER_REPLY_OPTIONS.find((option) =>
    groupValue.includes(String(option))
  )
}

/**
 * Finds the approval a toggle group selected.
 *
 * @param groupValue - Pressed item values the toggle group reports.
 * @returns The selected approval, or `undefined` when the group reports no
 * offered approval, as when the pressed item is pressed again.
 */
export function findToolApproval(
  groupValue: readonly string[]
): ToolApproval | undefined {
  return TOOL_APPROVALS.find((approval) => groupValue.includes(approval))
}
