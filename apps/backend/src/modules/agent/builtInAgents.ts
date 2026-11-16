import {
  ARMITAGE_AGENT_CODE,
  builtInAgentSchema,
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE,
  type BuiltInAgent
} from "@lys/share"
import type { TurnMcpTool } from "../mcp/mcpServerRegistry"

/**
 * System prompts of the built-in agents, each non-empty text without
 * surrounding whitespace.
 */
export type BuiltInAgentPrompts = Readonly<{
  /** System prompt of Caliginia, Lys's dark side. */
  caliginia: string
  /** System prompt of Lysiptera, Lys's light side. */
  lysiptera: string
  /** System prompt of Armitage, the tool keeper. */
  armitage: string
}>

/**
 * Codes of the agents that are Lys herself, Caliginia and Lysiptera, whose
 * email address is Lys's own.
 */
const LYS_AGENT_CODES: ReadonlySet<string> = new Set([
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE
])

/**
 * Answers whether an agent is Lys herself: Caliginia or Lysiptera, whose
 * email address is that of Lys's own mailbox.
 *
 * @param code - Code of the agent.
 * @returns True for Caliginia's and Lysiptera's codes; false for every other
 * agent, Armitage included.
 */
export function isLysAgentCode(code: string): boolean {
  return LYS_AGENT_CODES.has(code)
}

/**
 * Lists the MCP tools a turn of an agent offers.
 *
 * @param agentCode - Code of the agent that answers the turn.
 * @param tools - MCP tools found for the turn, in offer order.
 * @returns The tools unchanged for Caliginia and Lysiptera; for any other
 * agent, a frozen list without the tools only Lys may use, such as those of
 * her own mailbox, so the agent is never offered them, Armitage never finds
 * them for it, and nothing it reads names them.
 */
export function listAgentMcpTools(
  agentCode: string,
  tools: readonly TurnMcpTool[]
): readonly TurnMcpTool[] {
  if (isLysAgentCode(agentCode)) return tools
  return Object.freeze(tools.filter((tool) => !tool.isLysOnly))
}

/**
 * Builds the agents the backend ships with, in the order clients list them.
 *
 * @param prompts - System prompt of each built-in agent.
 * @returns The frozen list: Caliginia, Lysiptera, then Armitage, the tool
 * keeper, which answers agents, not chats. Each agent is frozen and
 * validated against the built-in agent schema.
 * @throws {z.ZodError} If a prompt is empty or has surrounding whitespace.
 */
export function buildBuiltInAgents(
  prompts: BuiltInAgentPrompts
): readonly BuiltInAgent[] {
  return Object.freeze([
    builtInAgentSchema.parse({
      code: CALIGINIA_AGENT_CODE,
      name: "Caliginia",
      bio: "Lys's dark side.",
      systemPrompt: prompts.caliginia
    } satisfies BuiltInAgent),
    builtInAgentSchema.parse({
      code: LYSIPTERA_AGENT_CODE,
      name: "Lysiptera",
      bio: "Lys's light side.",
      systemPrompt: prompts.lysiptera
    } satisfies BuiltInAgent),
    builtInAgentSchema.parse({
      code: ARMITAGE_AGENT_CODE,
      name: "Armitage",
      bio: "Lys's tool keeper. It finds the tools the other agents need and answers agents, not chats.",
      systemPrompt: prompts.armitage
    } satisfies BuiltInAgent)
  ])
}
