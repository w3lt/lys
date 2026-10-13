import { createAgentApi, updateAgentApi } from "@lys/protocol"
import {
  agentSchema,
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE,
  type Agent,
  type AgentChanges,
  type AgentDefinition,
  type BuiltInAgent
} from "@lys/share"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendFake,
  type BackendRoutes,
  type ObservedBackendRequest
} from "./backendFake"
import {
  AGENT_FIXTURE_TIMESTAMP,
  buildAgentBuiltInProblem,
  buildAgentCodeTakenProblem,
  buildAgentListPage,
  buildAgentNotFoundProblem,
  buildBuiltInAgent,
  buildBuiltInAgentResponse,
  buildCustomAgentResponse
} from "./agentFixtures"

/**
 * Built-in agents the double lists and reads: Caliginia, then Lysiptera,
 * with the names and bios the backend ships them with.
 *
 * @remarks Their system prompts are fixture text, since the release supplies
 * the real ones.
 */
export const SHIPPED_BUILT_IN_AGENTS: readonly BuiltInAgent[] = Object.freeze([
  buildBuiltInAgent(CALIGINIA_AGENT_CODE, {
    name: "Caliginia",
    bio: "Lys's dark side."
  }),
  buildBuiltInAgent(LYSIPTERA_AGENT_CODE, {
    name: "Lysiptera",
    bio: "Lys's light side."
  })
])

/** Media type the backend sends every problem with. */
const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8"

/** Time the double's clock moves for each create or update, in milliseconds. */
const AGENT_CHANGE_STEP_MILLISECONDS = 1000

/** Options of {@link startAgentBackend}. */
export type AgentBackendOptions = Readonly<{
  /**
   * Code the backend stores a new agent created without one under: the first
   * free code it derives from the name, which the case works out. Required
   * only by cases that create such an agent.
   */
  derivedCode?: string
  /**
   * Codes of agents a case creates, so their read, update, and delete
   * routes exist.
   */
  createdCodes?: readonly string[]
  /**
   * Routes added to the double's, replacing any of its own with the same
   * key, such as a read the case holds pending.
   */
  routes?: BackendRoutes
}>

/** Backend double holding the built-in agents and a list of stored agents. */
export type AgentBackend = Readonly<{
  /** Observation handle of every request. */
  backend: BackendFake
  /**
   * Lists the stored agents.
   *
   * @returns The agents as stored now, oldest first.
   */
  listStoredAgents: () => readonly Agent[]
}>

/**
 * Builds the response the backend sends for a code no agent has.
 *
 * @returns A 404 carrying the agent-not-found problem.
 */
function buildAgentNotFoundResponse(): Response {
  return buildJsonResponse(
    404,
    buildAgentNotFoundProblem(),
    PROBLEM_CONTENT_TYPE
  )
}

/**
 * Builds the response the backend sends when a new agent's given code is
 * already a built-in or stored agent's.
 *
 * @returns A 409 carrying the agent-code-taken problem.
 */
function buildAgentCodeTakenResponse(): Response {
  return buildJsonResponse(
    409,
    buildAgentCodeTakenProblem(),
    PROBLEM_CONTENT_TYPE
  )
}

/**
 * Builds the response the backend sends when asked to change or delete a
 * built-in agent.
 *
 * @returns A 409 carrying the built-in agent problem.
 */
function buildAgentBuiltInResponse(): Response {
  return buildJsonResponse(
    409,
    buildAgentBuiltInProblem(),
    PROBLEM_CONTENT_TYPE
  )
}

/**
 * Calculates the time the double stamps on a create or update, standing in
 * for the backend's clock.
 *
 * @param agents - Agents stored before the change.
 * @returns One second after the latest `updatedAt` of those agents, which is
 * never before their `createdAt`, or after {@link AGENT_FIXTURE_TIMESTAMP}
 * when none is stored. A created agent is so the newest, and a change always
 * moves `updatedAt` forward.
 */
function calculateAgentChangeTime(agents: readonly Agent[]): string {
  const latestTime = Math.max(
    Date.parse(AGENT_FIXTURE_TIMESTAMP),
    ...agents.map((agent) => Date.parse(agent.updatedAt))
  )
  return new Date(latestTime + AGENT_CHANGE_STEP_MILLISECONDS).toISOString()
}

/**
 * Finds the code the backend stores a new agent under.
 *
 * @param definition - Validated definition of the new agent.
 * @param derivedCode - Code the case arranged for an agent created without
 * one, if any.
 * @param takenCodes - Codes of every built-in and stored agent.
 * @returns The given code, or the derived code when none is given; undefined
 * when the given code is taken, which the backend refuses with 409.
 * @throws An `Error` when no code is given and the case arranged no derived
 * code or a taken one. The backend never refuses a new agent without a code:
 * it stores it under the next free derived code (`-2`, `-3`, …), which the
 * double does not derive, so the case must arrange a free one.
 */
function findNewAgentCode(
  definition: AgentDefinition,
  derivedCode: string | undefined,
  takenCodes: ReadonlySet<string>
): string | undefined {
  if (definition.code !== undefined) {
    return takenCodes.has(definition.code) ? undefined : definition.code
  }
  if (derivedCode === undefined) {
    throw new Error("The case arranged no code to derive for a new agent.")
  }
  if (takenCodes.has(derivedCode)) {
    throw new Error(
      `The derived code ${derivedCode} is taken; arrange the next free one.`
    )
  }
  return derivedCode
}

/**
 * Builds a new agent as the backend stores it.
 *
 * @param code - Code the agent is stored under, given or derived.
 * @param definition - Validated, trimmed definition.
 * @param createdAt - Creation time, also stored as the time of the latest
 * change.
 * @returns The agent, validated by the shared schema.
 */
function buildCreatedAgent(
  code: string,
  definition: AgentDefinition,
  createdAt: string
): Agent {
  return agentSchema.parse({
    code,
    name: definition.name,
    bio: definition.bio,
    systemPrompt: definition.systemPrompt,
    createdAt,
    updatedAt: createdAt
  })
}

/**
 * Builds a stored agent with a change applied, as the backend stores it.
 *
 * @param agent - Agent as stored before the change.
 * @param changes - Validated, trimmed change; each given field replaces the
 * stored one.
 * @param updatedAt - Time of the change.
 * @returns The changed agent, its code and `createdAt` kept, validated by the
 * shared schema.
 */
function buildChangedAgent(
  agent: Agent,
  changes: AgentChanges,
  updatedAt: string
): Agent {
  return agentSchema.parse({
    ...agent,
    name: changes.name ?? agent.name,
    bio: changes.bio ?? agent.bio,
    systemPrompt: changes.systemPrompt ?? agent.systemPrompt,
    updatedAt
  })
}

/**
 * Handles a request to change a built-in agent, which the backend refuses.
 *
 * @param request - Observed PATCH request.
 * @returns A 409 carrying the built-in agent problem; nothing changes.
 * @throws A `ZodError` when the body is not a valid agent change, which the
 * backend rejects before it refuses the change.
 */
function handleBuiltInAgentUpdateRequest(
  request: ObservedBackendRequest
): Response {
  updateAgentApi.body.parse(request.body)
  return buildAgentBuiltInResponse()
}

/**
 * Builds the routes of one built-in agent.
 *
 * @param agent - Built-in agent the routes address.
 * @returns Its read route, which answers the agent tagged `built-in`, and
 * its update and delete routes, which answer 409 with the built-in agent
 * problem and change nothing.
 */
function buildBuiltInAgentRoutes(agent: BuiltInAgent): BackendRoutes {
  const path = `/api/v1/agents/${agent.code}`
  return {
    [`GET ${path}`]: () =>
      buildJsonResponse(200, buildBuiltInAgentResponse(agent)),
    [`PATCH ${path}`]: handleBuiltInAgentUpdateRequest,
    [`DELETE ${path}`]: buildAgentBuiltInResponse
  }
}

/**
 * Starts a backend that ships {@link SHIPPED_BUILT_IN_AGENTS}, stores agents
 * in memory, and answers the agent routes the desktop uses against them.
 *
 * @param initialAgents - Agents stored when the case starts, oldest first,
 * none with a built-in agent's code.
 * @param options - Derived code, created codes, and added routes.
 * @returns The observation handle and a reader of the stored agents.
 * @remarks A list read answers every built-in agent and every stored agent
 * on one final page. A read answers the agent tagged `built-in` or `custom`.
 * A create stores the new agent as the newest, under its given code or the
 * arranged derived code, and answers 201; a given code that a built-in or
 * stored agent has answers 409 with the code-taken problem. An update
 * replaces the given fields, moves `updatedAt` forward, keeps `createdAt`,
 * and answers 200. A delete removes the agent and answers 204. An update or
 * delete of a built-in agent answers 409 with the built-in agent problem, and
 * a read, update, or delete of a code no agent has answers 404. Times come
 * from a deterministic clock (see {@link calculateAgentChangeTime}).
 *
 * Request bodies are parsed with the endpoints' shared schemas inside the
 * routes. The desktop must never send a body the backend would reject, so
 * such a body throws a `ZodError` rather than answering the backend's 400.
 * The backend fake records an exception thrown by a route and fails the case
 * when it finishes, while the desktop sees that request fail as if the
 * backend were unreachable. An arrangement the double does not support (see
 * {@link findNewAgentCode}) throws and fails the case the same way, and a
 * request for a code that is neither built in, initial, nor arranged has no
 * route, which also fails the case.
 */
export function startAgentBackend(
  initialAgents: readonly Agent[],
  options: AgentBackendOptions = {}
): AgentBackend {
  let agents: readonly Agent[] = [...initialAgents]

  /**
   * Finds one stored agent.
   *
   * @param code - Code from the request path.
   * @returns The agent as stored now, or undefined when none has the code.
   */
  function findStoredAgent(code: string): Agent | undefined {
    return agents.find((agent) => agent.code === code)
  }

  /**
   * Handles a request to create an agent.
   *
   * @param request - Observed POST request.
   * @returns A 201 carrying the agent stored as the newest, or a 409 carrying
   * the code-taken problem when its given code is a built-in or stored
   * agent's, which stores nothing.
   * @throws A `ZodError` for a body the backend rejects, or an `Error` for an
   * arrangement {@link findNewAgentCode} does not support.
   */
  function handleCreateAgentRequest(request: ObservedBackendRequest): Response {
    const definition = createAgentApi.body.parse(request.body)
    const takenCodes = new Set(
      [...SHIPPED_BUILT_IN_AGENTS, ...agents].map((agent) => agent.code)
    )
    const code = findNewAgentCode(definition, options.derivedCode, takenCodes)
    if (code === undefined) return buildAgentCodeTakenResponse()

    const createdAt = calculateAgentChangeTime(agents)
    const agent = buildCreatedAgent(code, definition, createdAt)
    agents = [...agents, agent]
    return buildJsonResponse(201, agent)
  }

  /**
   * Handles a request to read one stored agent.
   *
   * @param code - Code from the request path.
   * @returns A 200 carrying the agent tagged `custom`, or a 404 carrying the
   * agent-not-found problem when it is not stored.
   */
  function handleGetAgentRequest(code: string): Response {
    const agent = findStoredAgent(code)
    return agent === undefined
      ? buildAgentNotFoundResponse()
      : buildJsonResponse(200, buildCustomAgentResponse(agent))
  }

  /**
   * Handles a request to change one stored agent.
   *
   * @param code - Code from the request path.
   * @param request - Observed PATCH request.
   * @returns A 200 carrying the changed agent, or a 404 carrying the
   * agent-not-found problem when it is not stored, which changes nothing.
   * @throws A `ZodError` for a body the backend rejects.
   */
  function handleUpdateAgentRequest(
    code: string,
    request: ObservedBackendRequest
  ): Response {
    const changes = updateAgentApi.body.parse(request.body)
    const agent = findStoredAgent(code)
    if (agent === undefined) return buildAgentNotFoundResponse()

    const updatedAt = calculateAgentChangeTime(agents)
    const changed = buildChangedAgent(agent, changes, updatedAt)
    agents = agents.map((stored) => (stored.code === code ? changed : stored))
    return buildJsonResponse(200, changed)
  }

  /**
   * Handles a request to delete one stored agent.
   *
   * @param code - Code from the request path.
   * @returns A bodyless 204 once the agent is removed, or a 404 carrying the
   * agent-not-found problem when it is not stored.
   */
  function handleDeleteAgentRequest(code: string): Response {
    if (findStoredAgent(code) === undefined) return buildAgentNotFoundResponse()

    agents = agents.filter((agent) => agent.code !== code)
    return new Response(null, { status: 204 })
  }

  /**
   * Builds the routes addressing one code a stored agent has or may have.
   *
   * @param code - Code of an initial agent or of one the case creates.
   * @returns Its read, update, and delete routes, which answer against the
   * agents stored when each request arrives.
   */
  function buildStoredAgentRoutes(code: string): BackendRoutes {
    const path = `/api/v1/agents/${code}`
    return {
      [`GET ${path}`]: () => handleGetAgentRequest(code),
      [`PATCH ${path}`]: (request) => handleUpdateAgentRequest(code, request),
      [`DELETE ${path}`]: () => handleDeleteAgentRequest(code)
    }
  }

  const storedCodes = [
    ...initialAgents.map((agent) => agent.code),
    ...(options.createdCodes ?? []),
    ...(options.derivedCode === undefined ? [] : [options.derivedCode])
  ]
  const listPageOptions = { builtInAgents: SHIPPED_BUILT_IN_AGENTS }
  const backend = startBackendFake(
    Object.assign(
      {
        "GET /api/v1/agents": () =>
          buildJsonResponse(200, buildAgentListPage(agents, listPageOptions)),
        "POST /api/v1/agents": handleCreateAgentRequest
      },
      ...storedCodes.map(buildStoredAgentRoutes),
      ...SHIPPED_BUILT_IN_AGENTS.map(buildBuiltInAgentRoutes),
      options.routes ?? {}
    )
  )
  return Object.freeze({ backend, listStoredAgents: () => agents })
}
