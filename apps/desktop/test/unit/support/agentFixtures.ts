import {
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema,
  listAgentsApi,
  type AgentCodeTakenProblem,
  type AgentNotFoundProblem,
  type AgentSummary,
  type ListAgentsApiResponse
} from "@lys/protocol"
import { agentSchema, type Agent } from "@lys/share"

/** Timestamp shared by agent fixtures whose time is not under test. */
export const AGENT_FIXTURE_TIMESTAMP = "2026-02-03T04:05:06.789Z"

/** Stored fields a case may vary; the others derive from the code. */
export type AgentFixture = Readonly<{
  /** Display name; defaults to `Agent <code>`. */
  name?: string
  /** Short description; defaults to `Bio of <code>.`. */
  bio?: string
  /** System prompt; defaults to `You are <code>.`. */
  systemPrompt?: string
  /** Time of the latest change; defaults to the creation time. */
  updatedAt?: string
}>

/**
 * Builds one stored agent as the backend returns it.
 *
 * @param code - Agent code.
 * @param fixture - Stored fields the case depends on.
 * @returns A frozen agent validated by the shared schema.
 */
export function buildAgent(code: string, fixture: AgentFixture = {}): Agent {
  return agentSchema.parse({
    code,
    name: fixture.name ?? `Agent ${code}`,
    bio: fixture.bio ?? `Bio of ${code}.`,
    systemPrompt: fixture.systemPrompt ?? `You are ${code}.`,
    createdAt: AGENT_FIXTURE_TIMESTAMP,
    updatedAt: fixture.updatedAt ?? AGENT_FIXTURE_TIMESTAMP
  })
}

/**
 * Builds the list summary of one stored agent.
 *
 * @param agent - Stored agent.
 * @returns The agent without its system prompt.
 */
export function buildAgentSummary(agent: Agent): AgentSummary {
  return Object.freeze({
    code: agent.code,
    name: agent.name,
    bio: agent.bio,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  })
}

/**
 * Builds one page of the agent list.
 *
 * @param agents - Listed agents, oldest first.
 * @param page - Stored count, defaulting to the number listed, and the
 * continuation, defaulting to null for the final page.
 * @returns A page validated by the shared list schema.
 */
export function buildAgentListPage(
  agents: readonly Agent[],
  page: Readonly<{ storedCount?: number; nextCursor?: string | null }> = {}
): ListAgentsApiResponse {
  return listAgentsApi.response.parse({
    agents: agents.map(buildAgentSummary),
    storedCount: page.storedCount ?? agents.length,
    nextCursor: page.nextCursor ?? null
  })
}

/**
 * Builds the problem the backend sends for an agent it does not store.
 *
 * @returns A problem body validated by the shared schema.
 */
export function buildAgentNotFoundProblem(): AgentNotFoundProblem {
  return agentNotFoundProblemSchema.parse({
    type: "urn:lys:problem:agent:not-found",
    title: "Agent not found",
    status: 404,
    detail: "No agent is stored under this code."
  })
}

/**
 * Builds the problem the backend sends when an agent code is already stored.
 *
 * @returns A problem body validated by the shared schema.
 */
export function buildAgentCodeTakenProblem(): AgentCodeTakenProblem {
  return agentCodeTakenProblemSchema.parse({
    type: "urn:lys:problem:agent:code-taken",
    title: "Agent code taken",
    status: 409,
    detail: "Another agent is stored under this code."
  })
}
