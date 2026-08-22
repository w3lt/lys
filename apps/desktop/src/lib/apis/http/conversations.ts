import {
  BACKEND_HOST,
  BACKEND_PORT,
  buildApiConversationPath,
  conversationDeleteApi,
  conversationGetApi,
  type ConversationGetApiResponse,
  conversationListApi,
  type ConversationListApiQuery,
  type ConversationListApiResponse,
  conversationUpdateTitleApi,
  type ConversationUpdateTitleApiResponse
} from "@lys/protocol"

/** Transport options shared by every conversation history request. */
export type ConversationApiOptions = {
  /** Signal that requests cancellation of the HTTP request. */
  readonly signal?: AbortSignal
}

/** Origin serving the conversation history routes. */
const BACKEND_ORIGIN = `http://${BACKEND_HOST}:${BACKEND_PORT}`

/**
 * Builds the search parameters for one conversation list request.
 *
 * @param query - Validated list query whose absent members are omitted.
 * @returns Search parameters containing only the supplied members.
 */
function buildConversationListSearch(
  query: ConversationListApiQuery
): URLSearchParams {
  const search = new URLSearchParams()

  if (query.query !== undefined) search.set("query", query.query)
  if (query.cursor !== undefined) search.set("cursor", query.cursor)
  if (query.limit !== undefined) search.set("limit", String(query.limit))

  return search
}

/**
 * Sends one conversation history request and validates its JSON body.
 *
 * @param request - Complete request already addressed at the backend origin.
 * @param parseResponseBody - Authoritative parser for the successful body.
 * @returns The validated response body.
 * @throws If the request fails, the backend rejects it, or the body is invalid.
 */
async function readConversationApiJson<TResponse>(
  request: Request,
  parseResponseBody: (responseBody: unknown) => TResponse
): Promise<TResponse> {
  const response = await fetch(request)
  if (!response.ok) {
    throw new Error(
      `Conversation request failed: ${response.status} ${request.method}`
    )
  }

  return parseResponseBody(await response.json())
}

/**
 * Lists stored conversations matching one optional search query.
 *
 * @param query - Search query, continuation cursor, and page size.
 * @param options - Optional transport cancellation settings.
 * @returns One page of conversation summaries with its result counts.
 * @throws If the request fails, the backend rejects it, or the body is invalid.
 */
export async function listConversations(
  query: ConversationListApiQuery,
  options?: ConversationApiOptions
): Promise<ConversationListApiResponse> {
  const search = buildConversationListSearch(query)
  const request = new Request(
    `${BACKEND_ORIGIN}${conversationListApi.path}?${search.toString()}`,
    {
      method: conversationListApi.method,
      headers: { Accept: "application/json" },
      signal: options?.signal
    }
  )

  return readConversationApiJson(request, (responseBody) =>
    conversationListApi.response.parse(responseBody)
  )
}

/**
 * Gets one stored conversation together with its complete transcript.
 *
 * @param conversationId - Identifier of the conversation to read.
 * @param options - Optional transport cancellation settings.
 * @returns The conversation and its ordered messages.
 * @throws If the request fails, the backend rejects it, or the body is invalid.
 */
export async function getConversation(
  conversationId: string,
  options?: ConversationApiOptions
): Promise<ConversationGetApiResponse> {
  const request = new Request(
    `${BACKEND_ORIGIN}${buildApiConversationPath(conversationId)}`,
    {
      method: conversationGetApi.method,
      headers: { Accept: "application/json" },
      signal: options?.signal
    }
  )

  return readConversationApiJson(request, (responseBody) =>
    conversationGetApi.response.parse(responseBody)
  )
}

/**
 * Updates the persisted title of one conversation.
 *
 * @param conversationId - Identifier of the conversation to rename.
 * @param title - Replacement title, which must be non-empty once trimmed.
 * @param options - Optional transport cancellation settings.
 * @returns The conversation metadata persisted by the backend.
 * @throws If the request fails, the backend rejects it, or the body is invalid.
 */
export async function updateConversationTitle(
  conversationId: string,
  title: string,
  options?: ConversationApiOptions
): Promise<ConversationUpdateTitleApiResponse> {
  const request = new Request(
    `${BACKEND_ORIGIN}${buildApiConversationPath(conversationId)}`,
    {
      method: conversationUpdateTitleApi.method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ title }),
      signal: options?.signal
    }
  )

  return readConversationApiJson(request, (responseBody) =>
    conversationUpdateTitleApi.response.parse(responseBody)
  )
}

/**
 * Permanently deletes one conversation and its messages.
 *
 * @param conversationId - Identifier of the conversation to delete.
 * @param options - Optional transport cancellation settings.
 * @returns A promise that resolves after the backend confirms deletion.
 * @throws If the request fails or the backend rejects it.
 */
export async function deleteConversation(
  conversationId: string,
  options?: ConversationApiOptions
): Promise<void> {
  const response = await fetch(
    `${BACKEND_ORIGIN}${buildApiConversationPath(conversationId)}`,
    {
      method: conversationDeleteApi.method,
      signal: options?.signal
    }
  )

  if (response.status !== conversationDeleteApi.successStatus) {
    throw new Error(`Conversation deletion failed: ${response.status}`)
  }
}
