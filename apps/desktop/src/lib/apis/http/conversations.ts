import {
  conversationNotFoundProblemSchema,
  deleteConversationApi,
  getConversationApi,
  listConversationsApi,
  updateConversationTitleApi,
  type ListConversationsApiQuery,
  type ListConversationsApiResponse
} from "@lys/protocol"
import type { Conversation, ConversationMetadata } from "@lys/share"

/** Transport scope sampled once for one conversation request. */
export type ConversationApiConnection = {
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

/** Replacement title requested for one stored conversation. */
export type ConversationTitleUpdate = {
  /** UUIDv7 of the conversation to rename. */
  readonly conversationId: string
  /** Candidate title; the endpoint contract trims it and rejects empty text. */
  readonly title: string
}

/** Outcome for an addressed conversation the backend reports as not stored. */
type ConversationNotFoundResult = {
  /** The backend returned the declared missing-conversation problem. */
  readonly status: "not-found"
}

/** Outcome of reading one stored conversation. */
export type GetConversationResult =
  | {
      /** The conversation exists and was read completely. */
      readonly status: "found"
      /** Validated conversation, including its ordered transcript. */
      readonly conversation: Conversation
    }
  | ConversationNotFoundResult

/** Outcome of replacing one stored conversation's title. */
export type UpdateConversationTitleResult =
  | {
      /** The backend persisted the replacement title. */
      readonly status: "updated"
      /** Validated metadata carrying the persisted title. */
      readonly conversation: ConversationMetadata
    }
  | ConversationNotFoundResult

/** Outcome of permanently deleting one stored conversation. */
export type DeleteConversationResult =
  | {
      /** The backend removed the conversation and its transcript. */
      readonly status: "deleted"
    }
  | ConversationNotFoundResult

/** Complete HTTP request assembled by one conversation endpoint adapter. */
type ConversationHttpRequest = ConversationApiConnection & {
  /** Method declared by the shared endpoint descriptor. */
  readonly method: string
  /** Route with encoded path parameters and any query string applied. */
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
const CONVERSATION_NOT_FOUND_RESULT: ConversationNotFoundResult = Object.freeze(
  { status: "not-found" }
)

/** Shared deletion outcome; it carries no per-occurrence data. */
const CONVERSATION_DELETED_RESULT: DeleteConversationResult = Object.freeze({
  status: "deleted"
})

/**
 * Gets the response to one conversation request in any HTTP status.
 *
 * @param request - Endpoint, body, origin, and cancellation scope.
 * @returns The response whose body remains owned by the endpoint adapter.
 * @throws The original abort failure when the signal was aborted, or a
 * caller-safe error retaining the transport failure as its cause.
 */
async function getConversationResponse(
  request: ConversationHttpRequest
): Promise<Response> {
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
function createConversationResponseError(status: number): Error {
  return new Error(
    `The backend could not complete the conversation request (HTTP ${status}).`
  )
}

/**
 * Reads a failed response's body as untrusted JSON.
 *
 * @param response - Failed response whose body is consumed here.
 * @returns The decoded body, or undefined when it is not readable JSON.
 */
async function readFailureBody(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json()
    return body
  } catch {
    return undefined
  }
}

/**
 * Determines whether a decoded body is the missing-conversation problem.
 *
 * @param body - Untrusted body of a failed response.
 * @returns Whether it validates as the declared problem; a different body,
 * such as the one an unregistered route returns, does not.
 */
function isConversationNotFoundProblem(body: unknown): boolean {
  return conversationNotFoundProblemSchema.safeParse(body).success
}

/**
 * Parses a failed response for an addressed conversation into its outcome.
 *
 * @param response - Failed response whose body is consumed here.
 * @returns The absence outcome for the declared missing-conversation problem.
 * @throws A caller-safe error naming the HTTP status for every other failure.
 */
async function parseConversationFailure(
  response: Response
): Promise<ConversationNotFoundResult> {
  if (response.status !== 404) {
    throw createConversationResponseError(response.status)
  }
  if (!isConversationNotFoundProblem(await readFailureBody(response))) {
    throw createConversationResponseError(response.status)
  }

  return CONVERSATION_NOT_FOUND_RESULT
}

/**
 * Decodes a successful JSON response without exposing malformed payloads.
 *
 * @typeParam TPayload - Validated endpoint response type.
 * @param response - Response consumed by this boundary.
 * @param parsePayload - Authoritative shared schema parser for the endpoint.
 * @returns The validated payload after the body is consumed.
 * @throws A caller-safe error when the status, media type, JSON, or schema is
 * not the declared success representation; decoding causes are retained.
 */
async function parseConversationPayload<TPayload>(
  response: Response,
  parsePayload: (payload: unknown) => TPayload
): Promise<TPayload> {
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim()
  if (response.status !== 200 || mediaType !== "application/json") {
    throw new Error("The backend returned an unexpected conversation response.")
  }

  try {
    const payload: unknown = await response.json()
    return parsePayload(payload)
  } catch (cause) {
    throw new Error("The backend returned an invalid conversation response.", {
      cause
    })
  }
}

/**
 * Builds the path addressing one conversation from a shared route template.
 *
 * @param routeTemplate - Descriptor path containing `:conversationId`.
 * @param conversationId - Validated identifier substituted after encoding.
 * @returns The route with its identifier percent-encoded.
 */
function buildConversationPath(
  routeTemplate: string,
  conversationId: string
): string {
  return routeTemplate.replace(
    ":conversationId",
    encodeURIComponent(conversationId)
  )
}

/**
 * Builds the list route with only the query parameters that are present.
 *
 * @param query - Validated list parameters; omitted fields are not sent.
 * @returns The list path followed by an encoded query string when needed.
 */
function buildConversationListPath(query: ListConversationsApiQuery): string {
  const searchParams = new URLSearchParams()
  if (query.query !== undefined) searchParams.set("query", query.query)
  if (query.cursor !== undefined) searchParams.set("cursor", query.cursor)
  if (query.limit !== undefined) searchParams.set("limit", String(query.limit))

  const search = searchParams.toString()
  return search
    ? `${listConversationsApi.path}?${search}`
    : listConversationsApi.path
}

/**
 * Determines whether one page lists any conversation more than once.
 *
 * @param page - Schema-validated list page.
 * @returns Whether two listed conversations share an identifier.
 */
function hasDuplicateConversation(page: ListConversationsApiResponse): boolean {
  const conversationIds = new Set(
    page.conversations.map((conversation) => conversation.id)
  )
  return conversationIds.size !== page.conversations.length
}

/**
 * Lists one page of stored conversations, newest activity first.
 *
 * @param query - Search, continuation, and page-size parameters; the search
 * text must already be trimmed and non-empty when present.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The validated page after its body is consumed.
 * @throws On invalid parameters, cancellation, transport failure, any failed
 * HTTP status, or a malformed page, including duplicate conversations.
 */
export async function listConversations(
  query: ListConversationsApiQuery,
  connection: ConversationApiConnection
): Promise<ListConversationsApiResponse> {
  const validatedQuery = listConversationsApi.querystring.parse(query)
  const response = await getConversationResponse({
    ...connection,
    method: listConversationsApi.method,
    path: buildConversationListPath(validatedQuery)
  })
  if (!response.ok) throw createConversationResponseError(response.status)

  const page = await parseConversationPayload(
    response,
    listConversationsApi.response.parse
  )
  if (hasDuplicateConversation(page)) {
    throw new Error("The backend listed a conversation more than once.")
  }

  return page
}

/**
 * Reads one stored conversation with its complete transcript.
 *
 * @param conversationId - UUIDv7 of the conversation to read.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The conversation, or the absence outcome when the backend reports
 * the declared missing-conversation problem.
 * @throws On an invalid identifier, cancellation, transport failure, any other
 * failed status, a malformed conversation, or a mismatched identity.
 */
export async function getConversation(
  conversationId: string,
  connection: ConversationApiConnection
): Promise<GetConversationResult> {
  const params = getConversationApi.params.parse({ conversationId })
  const response = await getConversationResponse({
    ...connection,
    method: getConversationApi.method,
    path: buildConversationPath(getConversationApi.path, params.conversationId)
  })
  if (!response.ok) return await parseConversationFailure(response)

  const conversation = await parseConversationPayload(
    response,
    getConversationApi.response.parse
  )
  if (conversation.id !== params.conversationId) {
    throw new Error("The backend returned a different conversation.")
  }

  return Object.freeze({ status: "found", conversation })
}

/**
 * Replaces one stored conversation's title.
 *
 * @param update - Conversation identity and candidate title.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The persisted metadata, or the absence outcome when the backend
 * reports the declared missing-conversation problem.
 * @throws On an invalid identifier or title, cancellation, transport failure,
 * any other failed status, malformed metadata, or a mismatched identity.
 * @remarks Aborting after the backend accepted the request can leave the new
 * title persisted; a later list read establishes the stored title.
 */
export async function updateConversationTitle(
  update: ConversationTitleUpdate,
  connection: ConversationApiConnection
): Promise<UpdateConversationTitleResult> {
  const params = updateConversationTitleApi.params.parse({
    conversationId: update.conversationId
  })
  const body = updateConversationTitleApi.body.parse({ title: update.title })
  const response = await getConversationResponse({
    ...connection,
    method: updateConversationTitleApi.method,
    path: buildConversationPath(
      updateConversationTitleApi.path,
      params.conversationId
    ),
    body: JSON.stringify(body)
  })
  if (!response.ok) return await parseConversationFailure(response)

  const conversation = await parseConversationPayload(
    response,
    updateConversationTitleApi.response.parse
  )
  if (conversation.id !== params.conversationId) {
    throw new Error("The backend renamed a different conversation.")
  }

  return Object.freeze({ status: "updated", conversation })
}

/**
 * Permanently deletes one stored conversation and its transcript.
 *
 * @param conversationId - UUIDv7 of the conversation to delete.
 * @param connection - Backend origin and local cancellation signal.
 * @returns The deletion outcome, or the absence outcome when the backend
 * reports the declared missing-conversation problem; both establish that the
 * conversation is no longer stored.
 * @throws On an invalid identifier, cancellation, transport failure, any other
 * failed status, or an unexpected success status.
 * @remarks Aborting after the backend accepted the request can still delete
 * the conversation.
 */
export async function deleteConversation(
  conversationId: string,
  connection: ConversationApiConnection
): Promise<DeleteConversationResult> {
  const params = deleteConversationApi.params.parse({ conversationId })
  const response = await getConversationResponse({
    ...connection,
    method: deleteConversationApi.method,
    path: buildConversationPath(
      deleteConversationApi.path,
      params.conversationId
    )
  })
  if (response.status === 204) return CONVERSATION_DELETED_RESULT
  if (!response.ok) return await parseConversationFailure(response)

  throw new Error("The backend returned an unexpected delete response.")
}
