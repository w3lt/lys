import {
  agentChangesSchema,
  agentDefinitionSchema,
  type Agent
} from "@lys/share"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendFake,
  type BackendRoute,
  type BackendRoutes
} from "./backendFake"
import {
  buildAgent,
  buildAgentCodeTakenProblem,
  buildAgentListPage,
  buildAgentNotFoundProblem
} from "./agentFixtures"

/** Options of {@link startAgentBackend}. */
export type AgentBackendOptions = Readonly<{
  /**
   * Code the backend derives for a new agent created without one; required
   * only by cases that create such an agent.
   */
  derivedCode?: string
  /**
   * Codes of agents a case creates, so their read, update, and delete
   * routes exist.
   */
  createdCodes?: readonly string[]
  /** Routes replacing the stored-agent routes. */
  routes?: BackendRoutes
}>

/** Backend double holding a list of stored agents. */
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
 * Starts a backend that stores agents in memory and answers the agent
 * routes the desktop uses against that list.
 *
 * @param initialAgents - Agents stored when the case starts, oldest first.
 * @param options - Derived code, created codes, and replacement routes.
 * @returns The observation handle and a reader of the stored agents.
 * @remarks Request bodies are parsed with the shared agent schemas, so a
 * body the backend would reject fails the case. Reads list every stored
 * agent on one final page. Creating stores
 * the request's fields under its code, or under the derived code when it has
 * none, and answers 409 when that code is taken. Updating merges the
 * request's fields into the stored agent. Deleting removes it and answers
 * 204. A read, update, or delete of an agent that is not stored answers 404.
 */
export function startAgentBackend(
  initialAgents: readonly Agent[],
  options: AgentBackendOptions = {}
): AgentBackend {
  let agents: readonly Agent[] = [...initialAgents]
  const findAgent = (code: string) =>
    agents.find((agent) => agent.code === code)
  const notFound = () => buildJsonResponse(404, buildAgentNotFoundProblem())

  const create: BackendRoute = (request) => {
    const fields = agentDefinitionSchema.parse(request.body)
    const code = fields.code ?? options.derivedCode
    if (code === undefined) throw new Error("No code to store the agent under")
    if (findAgent(code) !== undefined) {
      return buildJsonResponse(409, buildAgentCodeTakenProblem())
    }
    const agent = buildAgent(code, {
      name: fields.name,
      bio: fields.bio,
      systemPrompt: fields.systemPrompt
    })
    agents = [...agents, agent]
    return buildJsonResponse(201, agent)
  }

  const storedAgentRoutes = (code: string): BackendRoutes => ({
    [`GET /api/v1/agents/${code}`]: () => {
      const agent = findAgent(code)
      return agent === undefined ? notFound() : buildJsonResponse(200, agent)
    },
    [`PATCH /api/v1/agents/${code}`]: (request) => {
      const agent = findAgent(code)
      if (agent === undefined) return notFound()
      const fields = agentChangesSchema.parse(request.body)
      const changed = buildAgent(code, {
        name: fields.name ?? agent.name,
        bio: fields.bio ?? agent.bio,
        systemPrompt: fields.systemPrompt ?? agent.systemPrompt
      })
      agents = agents.map((stored) => (stored.code === code ? changed : stored))
      return buildJsonResponse(200, changed)
    },
    [`DELETE /api/v1/agents/${code}`]: () => {
      if (findAgent(code) === undefined) return notFound()
      agents = agents.filter((agent) => agent.code !== code)
      return new Response(null, { status: 204 })
    }
  })

  const codes = [
    ...initialAgents.map((agent) => agent.code),
    ...(options.createdCodes ?? []),
    ...(options.derivedCode === undefined ? [] : [options.derivedCode])
  ]
  const backend = startBackendFake(
    Object.assign(
      {
        "GET /api/v1/agents": () =>
          buildJsonResponse(200, buildAgentListPage(agents)),
        "POST /api/v1/agents": create
      },
      ...codes.map(storedAgentRoutes),
      options.routes ?? {}
    )
  )
  return Object.freeze({ backend, listStoredAgents: () => agents })
}
