import {
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema,
  createAgentApi,
  deleteAgentApi,
  getAgentApi,
  listAgentsApi,
  updateAgentApi,
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

/** Outcome for an addressed agent the backend reports as not stored. */
type AgentNotFoundResult = {
  /** The backend returned the declared missing-agent problem. */
  readonly status: "not-found"
}

/** Outcome of reading one stored agent. */
export type GetAgentResult =
  | {
      /** The agent exists and was read with its system prompt. */
      readonly status: "found"
      /** Validated stored agent. */
      readonly agent: Agent
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
      /** Another stored agent already has the requested code. */
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

/** Outcome of permanently deleting one stored agent. */
export type DeleteAgentResult =
  | {
      /** The backend removed the agent. */
      readonly status: "deleted"
    }
  | AgentNotFoundResult

/** Complete HTTP request assembled by one agent endpoint adapter. */
type AgentHttpRequest = AgentApiConnection & {
  /** Method declared by the shared endpoint descriptor. */
  readonly method: string
  /** Route with path parameters and any query string applied. */
  readonly path: string
  /** Serialized validated JSON body, omitted for bodyless requests. */
  readonly body?: string
}

/** Headers for a request without a body; Fastify rejects empty JSON bodies. */
const ACCEPT_JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: "application/json"
})

/** Headers for a request carrying a serialized JSON body. */
const SEND_JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json"
})

/** Shared absence outcome; it carries no per-occurrence data. */
const AGENT_NOT_FOUND_RESULT: AgentNotFoundResult = Object.freeze({
  status: "not-found"
})

/** Shared deletion outcome; it carries no per-occurrence data. */
const AGENT_DELETED_RESULT: DeleteAgentResult = Object.freeze({
  status: "deleted"
})

/** Shared taken-code outcome; it carries no per-occurrence data. */
const AGENT_CODE_TAKEN_RESULT: CreateAgentResult = Object.freeze({
  status: "code-taken"
})

/** HTTP status of a successful read or update. */
const HTTP_OK_STATUS = 200

/** HTTP status of a successful creation. */
const HTTP_CREATED_STATUS = 201

/**
 * Gets the response to one agent request in any HTTP status.
 *
 * @param request - Endpoint, body, origin, and cancellation scope.
 * @returns The response whose body remains owned by the endpoint adapter.
 * @throws The original abort failure when the signal was aborted, or a
 * caller-safe error retaining the transport failure as its cause.
 */
async function getAgentResponse(request: AgentHttpRequest): Promise<Response> {
  const headers =
    request.body === undefined ? ACCEPT_JSON_HEADERS : SEND_JSON_HEADERS

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

  return AGENT_NOT_FOUND_RESULT
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
 * @returns Whether two listed agents share a code.
 */
function hasDuplicateAgent(page: ListAgentsApiResponse): boolean {
  const agentCodes = new Set(page.agents.map((agent) => agent.code))
  return agentCodes.size !== page.agents.length
}

/**
 * Lists one page of stored agents, oldest first.
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
  const response = await getAgentResponse({
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
 * Reads one stored agent with its system prompt.
 *
 * @param agentCode - Code of the agent to read.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The agent, or the absence outcome when the backend reports the
 * declared missing-agent problem.
 * @throws On an invalid code, cancellation, transport failure, any other
 * failed status, a malformed agent, or a mismatched identity.
 */
export async function getAgent(
  agentCode: string,
  connection: AgentApiConnection
): Promise<GetAgentResult> {
  const params = getAgentApi.params.parse({ agentCode })
  const response = await getAgentResponse({
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
 * reports the declared agent-code-taken problem; nothing is stored then.
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
  const response = await getAgentResponse({
    ...connection,
    method: createAgentApi.method,
    path: createAgentApi.path,
    body: JSON.stringify(body)
  })
  if (response.status === 409) {
    const problem = await readAgentFailureBody(response)
    if (agentCodeTakenProblemSchema.safeParse(problem).success) {
      return AGENT_CODE_TAKEN_RESULT
    }
  }
  if (!response.ok) throw createAgentResponseError(response.status)

  const agent = await parseAgentPayload(
    response,
    HTTP_CREATED_STATUS,
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
 * @returns The changed agent, or the absence outcome when the backend reports
 * the declared missing-agent problem.
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
  const response = await getAgentResponse({
    ...connection,
    method: updateAgentApi.method,
    path: buildAgentPath(updateAgentApi.path, params.agentCode),
    body: JSON.stringify(body)
  })
  if (!response.ok) return await parseAgentFailure(response)

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
 * is no longer stored.
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
  const response = await getAgentResponse({
    ...connection,
    method: deleteAgentApi.method,
    path: buildAgentPath(deleteAgentApi.path, params.agentCode)
  })
  if (response.status === 204) return AGENT_DELETED_RESULT
  if (!response.ok) return await parseAgentFailure(response)

  throw new Error("The backend returned an unexpected delete response.")
}
