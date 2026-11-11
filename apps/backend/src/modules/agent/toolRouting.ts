import type { MessageGenerationOptions } from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"
import type { TurnMcpTool } from "../mcp/mcpServerRegistry"
import type { TurnBuiltInTool } from "../tool/builtIn/builtInTool"
import type { ToolCallPolicy } from "../toolApproval/toolCallPolicy"
import { formatSystemPrompt } from "./agentContext"
import FindToolsTool, {
  FIND_TOOLS_DEFINITION,
  formatToolRoutingNote,
  type ReportToolSearchFailure,
  type ToolKeeper
} from "./findToolsTool"
import ReplyToolOffer from "./replyToolOffer"
import { buildAgentToolset } from "./toolCallRound"
import type { UnofferedTools } from "./unofferedTools"

/**
 * How a turn offers its client, built-in, and MCP tools.
 *
 * @remarks `status` selects the variant. A routed turn offers them only
 * once Armitage, the tool keeper, finds them through `find_tools`; its
 * direct and state tools are offered from the first round either way.
 */
export type ToolRouting =
  | Readonly<{
      /** Every tool of the turn is offered from the first round. */
      status: "direct"
    }>
  | Readonly<{
      /** The turn offers `find_tools` in place of those tools. */
      status: "routed"
      /** Number of those tools; a positive integer. */
      toolCount: number
    }>

/** Definitions a turn or a measurement offers, by kind. */
export type OfferedDefinitionsInput = Readonly<{
  /** Definitions of the direct tools, in offer order. */
  directTools: readonly ToolDefinition[]
  /**
   * Definitions of the client, built-in, and MCP tools, each name once, in
   * offer order.
   */
  tools: readonly ToolDefinition[]
  /** Definitions of the agent's state tools; empty when none is offered. */
  agentStateTools: readonly ToolDefinition[]
  /** How the turn offers `tools`. */
  routing: ToolRouting
}>

/** What one reply's turn gives its tools and `find_tools`. */
export type ReplyToolsTurn = Readonly<{
  /** UUIDv7 of the turn's conversation. */
  conversationId: string
  /** Model the turn uses. */
  model: string
  /** Whether the model is trained for tool use. */
  trainedForToolUse: boolean
  /** Sampling and reply length controls of the turn. */
  generationOptions: MessageGenerationOptions
  /** Backend tools offered in every round, in offer order. */
  directTools: readonly TurnBuiltInTool[]
  /** Validated client tool definitions, in offer order. */
  clientTools: readonly ToolDefinition[]
  /** Built-in tools found for the turn, in offer order. */
  builtInTools: readonly TurnBuiltInTool[]
  /** MCP tools found for the turn, in offer order. */
  mcpTools: readonly TurnMcpTool[]
  /** Receives why a `find_tools` search ended without finding. */
  reportToolSearchFailure: ReportToolSearchFailure
  /** What the fixed tool call rules know about this machine. */
  toolCallPolicy: ToolCallPolicy
}>

/** What one reply offers its rounds. */
export type ReplyTools = Readonly<{
  /** How the turn offers its client, built-in, and MCP tools. */
  routing: ToolRouting
  /** The tools the reply's rounds offer, as each round starts. */
  toolOffer: ReplyToolOffer
  /**
   * The reply's `find_tools`, whose found tools the reply offers from its
   * next round; undefined when the turn is not routed.
   */
  findTools: FindToolsTool | undefined
}>

/** Routing of a turn that offers every tool from the first round. */
const DIRECT_TOOL_ROUTING: ToolRouting = Object.freeze({ status: "direct" })

/** Tools of a reply that does not route its tools: none. */
const NO_ROUTING_TOOLS: readonly TurnBuiltInTool[] = Object.freeze([])

/**
 * Finds how a turn offers its client, built-in, and MCP tools.
 *
 * @param trainedForToolUse - Whether the turn's model is trained for tool
 * use.
 * @param toolCount - Number of those tools; a non-negative integer.
 * @returns `routed` with the count when the model is trained for tool use
 * and the turn has such a tool; `direct` otherwise, as a model not trained
 * for tool use may not call `find_tools` before the tool it needs.
 */
export function findToolRouting(
  trainedForToolUse: boolean,
  toolCount: number
): ToolRouting {
  if (!trainedForToolUse || toolCount === 0) return DIRECT_TOOL_ROUTING
  return Object.freeze({ status: "routed", toolCount })
}

/**
 * Formats the system prompt every round of a turn sends.
 *
 * @param systemPrompt - The agent's own instructions.
 * @param unofferedTools - What the request names about the tools the turn
 * does not offer.
 * @param routing - How the turn offers its tools.
 * @returns The prompt {@link formatSystemPrompt} formats, followed for a
 * routed turn by a blank line and the note telling the model to call
 * `find_tools`.
 */
export function formatRoutedSystemPrompt(
  systemPrompt: string,
  unofferedTools: UnofferedTools,
  routing: ToolRouting
): string {
  const formatted = formatSystemPrompt(systemPrompt, unofferedTools)
  if (routing.status === "direct") return formatted
  return `${formatted}\n\n${formatToolRoutingNote(routing.toolCount)}`
}

/**
 * Lists the definitions the first round of a turn offers.
 *
 * @param input - The turn's direct, client, built-in, MCP, and state tool
 * definitions, and how it offers them.
 * @returns The direct tools, then the turn's tools or, for a routed turn,
 * `find_tools` in their place, then the state tools.
 */
export function listOfferedDefinitions(
  input: OfferedDefinitionsInput
): readonly ToolDefinition[] {
  const toolsOrRouting =
    input.routing.status === "routed" ? [FIND_TOOLS_DEFINITION] : input.tools
  return Object.freeze([
    ...input.directTools,
    ...toolsOrRouting,
    ...input.agentStateTools
  ])
}

/**
 * Builds the tools of one reply and what its first round offers.
 *
 * @param turn - The turn's tools, its conversation, its model, whether the
 * model is trained for tool use, and its controls.
 * @param agentStateTools - The agent's state tools for the turn; empty when
 * none is offered.
 * @param keeper - Keeper `find_tools` asks; lent for the reply.
 * @returns For a routed turn, a toolset that adds `find_tools`, which runs
 * without approval, after the direct tools, and an offer of the direct
 * tools, `find_tools`, and the state tools; otherwise an offer of every
 * tool and no `find_tools`. The routed reply's other tools stay in its
 * toolset, so each tool `find_tools` finds is offered once
 * {@link offerFoundTools} adds it, and each call of it passes the reply's
 * checks and gate.
 * @throws If two tools share a name, as {@link buildAgentToolset} throws.
 */
export function buildReplyTools(
  turn: ReplyToolsTurn,
  agentStateTools: readonly TurnBuiltInTool[],
  keeper: ToolKeeper
): ReplyTools {
  const keptTools = Object.freeze([
    ...turn.clientTools,
    ...turn.builtInTools.map((tool) => tool.definition),
    ...turn.mcpTools.map((tool) => tool.definition)
  ])
  const routing = findToolRouting(turn.trainedForToolUse, keptTools.length)
  const findTools =
    routing.status === "routed"
      ? new FindToolsTool({
          keeper,
          tools: keptTools,
          conversationId: turn.conversationId,
          model: turn.model,
          generationOptions: turn.generationOptions,
          reportFailure: turn.reportToolSearchFailure,
          toolCallPolicy: turn.toolCallPolicy
        })
      : undefined
  const routingTools =
    findTools === undefined
      ? NO_ROUTING_TOOLS
      : [buildFindToolsEntry(findTools)]
  const directTools = Object.freeze([...turn.directTools, ...routingTools])
  const tools = buildAgentToolset({
    directTools,
    clientTools: turn.clientTools,
    builtInTools: turn.builtInTools,
    mcpTools: turn.mcpTools,
    agentStateTools
  })
  const offeredNames =
    findTools === undefined
      ? tools.keys()
      : [...directTools, ...agentStateTools].map((tool) => tool.definition.name)
  const toolOffer = new ReplyToolOffer(tools, offeredNames)
  return Object.freeze({ routing, toolOffer, findTools })
}

/**
 * Offers the tools a reply's `find_tools` found so far from the reply's
 * next round.
 *
 * @param replyTools - The reply's tools; unchanged when the turn is not
 * routed.
 */
export function offerFoundTools(replyTools: ReplyTools): void {
  if (replyTools.findTools !== undefined)
    replyTools.toolOffer.addTools(replyTools.findTools.listFoundToolNames())
}

/**
 * Builds the toolset entry of a reply's `find_tools`.
 *
 * @param findTools - The reply's `find_tools`.
 * @returns The entry, whose calls run without approval: they only ask
 * Armitage which tools fit and run none.
 */
function buildFindToolsEntry(findTools: FindToolsTool): TurnBuiltInTool {
  return Object.freeze({
    definition: FIND_TOOLS_DEFINITION,
    tool: findTools,
    runsWithoutApproval: true
  })
}
