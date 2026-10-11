import {
  agentBuiltInProblemSchema,
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema,
  getAgentApi,
  listAgentsApi,
  type AgentBuiltInProblem,
  type AgentCodeTakenProblem,
  type AgentNotFoundProblem,
  type AgentSummary,
  type BuiltInAgentSummary,
  type GetAgentApiResponse,
  type ListAgentsApiResponse
} from "@lys/protocol"
import {
  agentSchema,
  builtInAgentSchema,
  type Agent,
  type BuiltInAgent
} from "@lys/share"

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
 * Fields of a built-in agent a case may vary, with the defaults of
 * {@link AgentFixture}; a built-in agent has no times.
 */
export type BuiltInAgentFixture = Omit<AgentFixture, "updatedAt">

/** Continuation state and built-in agents of one list page. */
export type AgentListPageFixture = Readonly<{
  /** Number of stored agents on every page; defaults to the number listed. */
  storedCount?: number
  /** Continuation; defaults to null for the final page. */
  nextCursor?: string | null
  /** Built-in agents the page carries, in shipped order; defaults to none. */
  builtInAgents?: readonly BuiltInAgent[]
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
 * Builds one built-in agent as the backend ships it.
 *
 * @param code - Agent code, such as one of the shipped built-in codes.
 * @param fixture - Fields the case depends on.
 * @returns A frozen built-in agent validated by the shared schema.
 */
export function buildBuiltInAgent(
  code: string,
  fixture: BuiltInAgentFixture = {}
): BuiltInAgent {
  return builtInAgentSchema.parse({
    code,
    name: fixture.name ?? `Agent ${code}`,
    bio: fixture.bio ?? `Bio of ${code}.`,
    systemPrompt: fixture.systemPrompt ?? `You are ${code}.`
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
 * Builds the list summary of one built-in agent.
 *
 * @param agent - Built-in agent.
 * @returns The agent without its system prompt.
 */
export function buildBuiltInAgentSummary(
  agent: BuiltInAgent
): BuiltInAgentSummary {
  return Object.freeze({ code: agent.code, name: agent.name, bio: agent.bio })
}

/**
 * Builds one page of the agent list.
 *
 * @param agents - Listed stored agents, oldest first.
 * @param page - Stored count, continuation, and built-in agents; see
 * {@link AgentListPageFixture} for their defaults.
 * @returns A page validated by the shared list schema.
 */
export function buildAgentListPage(
  agents: readonly Agent[],
  page: AgentListPageFixture = {}
): ListAgentsApiResponse {
  return listAgentsApi.response.parse({
    builtInAgents: (page.builtInAgents ?? []).map(buildBuiltInAgentSummary),
    agents: agents.map(buildAgentSummary),
    storedCount: page.storedCount ?? agents.length,
    nextCursor: page.nextCursor ?? null
  })
}

/**
 * Builds the get-agent response for one stored agent.
 *
 * @param agent - Stored agent.
 * @returns The agent tagged `custom`, validated by the get-agent schema.
 */
export function buildCustomAgentResponse(agent: Agent): GetAgentApiResponse {
  return getAgentApi.response.parse({ kind: "custom", ...agent })
}

/**
 * Builds the get-agent response for one built-in agent.
 *
 * @param agent - Built-in agent.
 * @returns The agent tagged `built-in`, validated by the get-agent schema.
 */
export function buildBuiltInAgentResponse(
  agent: BuiltInAgent
): GetAgentApiResponse {
  return getAgentApi.response.parse({ kind: "built-in", ...agent })
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

/**
 * Builds the problem the backend sends when asked to change or delete a
 * built-in agent.
 *
 * @returns A problem body validated by the shared schema.
 */
export function buildAgentBuiltInProblem(): AgentBuiltInProblem {
  return agentBuiltInProblemSchema.parse({
    type: "urn:lys:problem:agent:built-in",
    title: "Built-in agent cannot be changed",
    status: 409,
    detail: "This agent is built in and cannot be changed or deleted."
  })
}
