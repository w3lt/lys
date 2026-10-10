import {
  agentBuiltInProblemSchema,
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema,
  createAgentApi,
  deleteAgentApi,
  getAgentApi,
  listAgentsApi,
  updateAgentApi,
  type GetAgentApiResponse,
  type ListAgentsApiQuery,
  type ListAgentsApiResponse
} from "@lys/protocol"
import type {
  Agent,
  AgentChangesCandidate,
  AgentDefinitionCandidate
} from "@lys/share"

/** Transport scope sampled once for one agent request. */
export type AgentApiConnection = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
  /**
   * Cancels local observation of the request; omission means the caller
   * observes the request until it settles.
   *
   * @remarks Aborting cannot recall a mutation the backend already accepted;
   * that mutation may still complete after the returned promise rejects.
   */
  readonly signal?: AbortSignal
}

/** Replacement fields requested for one stored agent. */
export type AgentUpdate = {
  /** Code of the agent to change; it never changes. */
  readonly agentCode: string
  /** Candidate fields; the endpoint contract trims them and rejects blanks. */
  readonly changes: AgentChangesCandidate
}

/** Outcome for an addressed code the backend reports no agent has. */
type AgentNotFoundResult = {
  /** The backend returned the declared missing-agent problem. */
  readonly status: "not-found"
}

/** Outcome for a change the backend refuses because the agent is built in. */
type AgentBuiltInResult = {
  /** The backend returned the declared built-in agent problem. */
  readonly status: "built-in"
}

/** Outcome of reading one built-in or stored agent. */
export type GetAgentResult =
  | {
      /** The agent exists and was read with its system prompt. */
      readonly status: "found"
      /** Validated agent, tagged built-in or custom. */
      readonly agent: GetAgentApiResponse
    }
  | AgentNotFoundResult

/** Outcome of storing a new agent. */
export type CreateAgentResult =
  | {
      /** The backend stored the agent. */
      readonly status: "created"
      /** Validated agent as stored, carrying its final code. */
      readonly agent: Agent
    }
  | {
      /** A built-in or stored agent already has the requested code. */
      readonly status: "code-taken"
    }

/** Outcome of changing one stored agent. */
export type UpdateAgentResult =
  | {
      /** The backend persisted the change. */
      readonly status: "updated"
      /** Validated agent with the change applied. */
      readonly agent: Agent
    }
  | AgentNotFoundResult
  | AgentBuiltInResult

/** Outcome of permanently deleting one stored agent. */
export type DeleteAgentResult =
  | {
      /** The backend removed the agent. */
      readonly status: "deleted"
    }
  | AgentNotFoundResult
  | AgentBuiltInResult

/** Complete HTTP request assembled by one agent endpoint adapter. */
type AgentHttpRequest = AgentApiConnection & {
  /** Method declared by the shared endpoint descriptor. */
  readonly method: string
  /** Route with path parameters and any query string applied. */
  readonly path: string
  /** Serialized validated JSON body, omitted for bodyless requests. */
  readonly body?: string
}

/** HTTP status of a successful read or update. */
const HTTP_OK_STATUS = 200

/**
 * Sends one agent request and returns its response in any HTTP status.
 *
 * @param request - Endpoint, body, origin, and cancellation scope.
 * @returns The response whose body remains owned by the endpoint adapter.
 * @throws The original abort failure when the signal was aborted, or a
 * caller-safe error retaining the transport failure as its cause.
 */
async function sendAgentRequest(request: AgentHttpRequest): Promise<Response> {
  // A bodyless request declares no content type; Fastify rejects empty JSON.
  const headers: Readonly<Record<string, string>> =
    request.body === undefined
      ? { Accept: "application/json" }
      : { Accept: "application/json", "Content-Type": "application/json" }

  try {
    return await fetch(`${request.backendUrl}${request.path}`, {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      cache: "no-store"
    })
  } catch (cause) {
    if (request.signal?.aborted) throw cause
    throw new Error("The backend could not be reached.", { cause })
  }
}

/**
 * Creates the caller-safe failure for an undeclared response status.
 *
 * @param status - HTTP status observed on the failed response.
 * @returns An error naming only the status, never server-provided text.
 */
function createAgentResponseError(status: number): Error {
  return new Error(
    `The backend could not complete the agent request (HTTP ${status}).`
  )
}

/**
 * Reads a failed response's body as untrusted JSON.
 *
 * @param response - Failed response whose body is consumed here.
 * @returns The decoded body, or undefined when it is not readable JSON.
 */
async function readAgentFailureBody(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json()
    return body
  } catch {
    return undefined
  }
}

/**
 * Parses a failed response for an addressed agent into its outcome.
 *
 * @param response - Failed response whose body is consumed here.
 * @returns The absence outcome for the declared missing-agent problem; a 404
 * without that body, such as an unregistered route, is not evidence of
 * absence.
 * @throws A caller-safe error naming the HTTP status for every other failure.
 */
async function parseAgentFailure(
  response: Response
): Promise<AgentNotFoundResult> {
  if (response.status !== 404) {
    throw createAgentResponseError(response.status)
  }
  const body = await readAgentFailureBody(response)
  if (!agentNotFoundProblemSchema.safeParse(body).success) {
    throw createAgentResponseError(response.status)
  }

  return Object.freeze({ status: "not-found" })
}

/**
 * Parses a failed response for a change to an addressed agent into its
 * outcome.
 *
 * @param response - Failed response whose body is consumed here.
 * @returns The built-in outcome for the declared built-in agent problem, or
 * the absence outcome for the declared missing-agent problem.
 * @throws A caller-safe error naming the HTTP status for every other failure,
 * including a 409 or 404 without its declared body.
 */
async function parseAgentChangeFailure(
  response: Response
): Promise<AgentNotFoundResult | AgentBuiltInResult> {
  if (response.status !== 409) return await parseAgentFailure(response)

  const body = await readAgentFailureBody(response)
  if (!agentBuiltInProblemSchema.safeParse(body).success) {
    throw createAgentResponseError(response.status)
  }
  return Object.freeze({ status: "built-in" })
}

/**
 * Decodes a successful JSON response without exposing malformed payloads.
 *
 * @typeParam TPayload - Validated endpoint response type.
 * @param response - Response consumed by this boundary.
 * @param successStatus - The one status the endpoint declares for success.
 * @param parsePayload - Authoritative shared schema parser for the endpoint.
 * @returns The validated payload after the body is consumed.
 * @throws A caller-safe error when the status, media type, JSON, or schema is
 * not the declared success representation; decoding causes are retained.
 */
async function parseAgentPayload<TPayload>(
  response: Response,
  successStatus: number,
  parsePayload: (payload: unknown) => TPayload
): Promise<TPayload> {
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  if (response.status !== successStatus || mediaType !== "application/json") {
    throw new Error("The backend returned an unexpected agent response.")
  }

  try {
    const payload: unknown = await response.json()
    return parsePayload(payload)
  } catch (cause) {
    throw new Error("The backend returned an invalid agent response.", {
      cause
    })
  }
}

/**
 * Builds the path addressing one agent from a shared route template.
 *
 * @param routeTemplate - Descriptor path containing `:agentCode`.
 * @param agentCode - Validated code; a valid code needs no percent-encoding,
 * so it is substituted as it is.
 * @returns The route addressing that agent.
 */
function buildAgentPath(routeTemplate: string, agentCode: string): string {
  return routeTemplate.replace(":agentCode", agentCode)
}

/**
 * Builds the list route with only the query parameters that are present.
 *
 * @param query - Validated list parameters; omitted fields are not sent.
 * @returns The list path followed by an encoded query string when needed.
 */
function buildAgentListPath(query: ListAgentsApiQuery): string {
  const searchParams = new URLSearchParams()
  if (query.cursor !== undefined) searchParams.set("cursor", query.cursor)
  if (query.limit !== undefined) searchParams.set("limit", String(query.limit))

  const search = searchParams.toString()
  return search ? `${listAgentsApi.path}?${search}` : listAgentsApi.path
}

/**
 * Determines whether one page lists any agent more than once.
 *
 * @param page - Schema-validated list page.
 * @returns Whether two listed agents, built-in or stored, share a code.
 */
function hasDuplicateAgent(page: ListAgentsApiResponse): boolean {
  const listedAgents = [...page.builtInAgents, ...page.agents]
  const agentCodes = new Set(listedAgents.map((agent) => agent.code))
  return agentCodes.size !== listedAgents.length
}

/**
 * Lists every built-in agent with one page of stored agents, oldest first.
 *
 * @param query - Continuation and page-size parameters.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The validated page after its body is consumed.
 * @throws On invalid parameters, cancellation, transport failure, any failed
 * HTTP status, or a malformed page, including duplicate agents.
 */
export async function listAgents(
  query: ListAgentsApiQuery,
  connection: AgentApiConnection
): Promise<ListAgentsApiResponse> {
  const validatedQuery = listAgentsApi.querystring.parse(query)
  const response = await sendAgentRequest({
    ...connection,
    method: listAgentsApi.method,
    path: buildAgentListPath(validatedQuery)
  })
  if (!response.ok) throw createAgentResponseError(response.status)

  const page = await parseAgentPayload(
    response,
    HTTP_OK_STATUS,
    listAgentsApi.response.parse
  )
  if (hasDuplicateAgent(page)) {
    throw new Error("The backend listed an agent more than once.")
  }

  return page
}

/**
 * Reads one built-in or stored agent with its system prompt.
 *
 * @param agentCode - Code of the agent to read.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The agent, tagged built-in or custom, or the absence outcome when
 * the backend reports the declared missing-agent problem.
 * @throws On an invalid code, cancellation, transport failure, any other
 * failed status, a malformed agent, or a mismatched identity.
 */
export async function getAgent(
  agentCode: string,
  connection: AgentApiConnection
): Promise<GetAgentResult> {
  const params = getAgentApi.params.parse({ agentCode })
  const response = await sendAgentRequest({
    ...connection,
    method: getAgentApi.method,
    path: buildAgentPath(getAgentApi.path, params.agentCode)
  })
  if (!response.ok) return await parseAgentFailure(response)

  const agent = await parseAgentPayload(
    response,
    HTTP_OK_STATUS,
    getAgentApi.response.parse
  )
  if (agent.code !== params.agentCode) {
    throw new Error("The backend returned a different agent.")
  }

  return Object.freeze({ status: "found", agent })
}

/**
 * Stores a new agent.
 *
 * @param definition - Candidate definition; an omitted code is derived from
 * the name by the backend.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The stored agent, or the taken-code outcome when the backend
 * reports the declared agent-code-taken problem, as for a built-in agent's
 * code; nothing is stored then.
 * @throws On an invalid definition, cancellation, transport failure, any
 * other failed status, a malformed agent, or a code other than the one given.
 * @remarks Creation is not idempotent. Aborting after the backend accepted
 * the request, or losing its response, can leave the agent stored; a later
 * list read establishes whether it was.
 */
export async function createAgent(
  definition: AgentDefinitionCandidate,
  connection: AgentApiConnection
): Promise<CreateAgentResult> {
  const body = createAgentApi.body.parse(definition)
  const response = await sendAgentRequest({
    ...connection,
    method: createAgentApi.method,
    path: createAgentApi.path,
    body: JSON.stringify(body)
  })
  if (response.status === 409) {
    const problem = await readAgentFailureBody(response)
    if (agentCodeTakenProblemSchema.safeParse(problem).success) {
      return Object.freeze({ status: "code-taken" })
    }
  }
  if (!response.ok) throw createAgentResponseError(response.status)

  const agent = await parseAgentPayload(
    response,
    201,
    createAgentApi.response.parse
  )
  if (body.code !== undefined && agent.code !== body.code) {
    throw new Error("The backend stored the agent under a different code.")
  }

  return Object.freeze({ status: "created", agent })
}

/**
 * Changes one stored agent's name, bio, or system prompt.
 *
 * @param update - Agent code and candidate replacement fields.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The changed agent, the absence outcome when the backend reports
 * the declared missing-agent problem, or the built-in outcome when it reports
 * the declared built-in agent problem; neither changes anything.
 * @throws On an invalid code or change, cancellation, transport failure, any
 * other failed status, a malformed agent, or a mismatched identity.
 * @remarks Aborting after the backend accepted the request can leave the
 * change persisted; repeating it stores the same values.
 */
export async function updateAgent(
  update: AgentUpdate,
  connection: AgentApiConnection
): Promise<UpdateAgentResult> {
  const params = updateAgentApi.params.parse({ agentCode: update.agentCode })
  const body = updateAgentApi.body.parse(update.changes)
  const response = await sendAgentRequest({
    ...connection,
    method: updateAgentApi.method,
    path: buildAgentPath(updateAgentApi.path, params.agentCode),
    body: JSON.stringify(body)
  })
  if (!response.ok) return await parseAgentChangeFailure(response)

  const agent = await parseAgentPayload(
    response,
    HTTP_OK_STATUS,
    updateAgentApi.response.parse
  )
  if (agent.code !== params.agentCode) {
    throw new Error("The backend changed a different agent.")
  }

  return Object.freeze({ status: "updated", agent })
}

/**
 * Permanently deletes one stored agent.
 *
 * @param agentCode - Code of the agent to delete.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The deletion outcome, or the absence outcome when the backend
 * reports the declared missing-agent problem; both establish that the agent
 * is no longer stored. The built-in outcome, when the backend reports the
 * declared built-in agent problem, establishes that the agent stays.
 * @throws On an invalid code, cancellation, transport failure, any other
 * failed status, or an unexpected success status.
 * @remarks Aborting after the backend accepted the request can still delete
 * the agent.
 */
export async function deleteAgent(
  agentCode: string,
  connection: AgentApiConnection
): Promise<DeleteAgentResult> {
  const params = deleteAgentApi.params.parse({ agentCode })
  const response = await sendAgentRequest({
    ...connection,
    method: deleteAgentApi.method,
    path: buildAgentPath(deleteAgentApi.path, params.agentCode)
  })
  if (response.status === 204) return Object.freeze({ status: "deleted" })
  if (!response.ok) return await parseAgentChangeFailure(response)

  throw new Error("The backend returned an unexpected delete response.")
}
