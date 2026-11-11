import {
  ARMITAGE_AGENT_CODE,
  builtInAgentSchema,
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE,
  type BuiltInAgent
} from "@lys/share"

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
