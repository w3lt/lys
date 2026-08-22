import { API_PREFIX_V1 } from "../../constant"

/** Collection route that lists stored conversations. */
export const apiConversationListRoute = `${API_PREFIX_V1}/conversations`

/**
 * Item route template for one stored conversation.
 *
 * @remarks The `:conversationId` segment is a Fastify path parameter. Clients
 * MUST build a concrete path with {@link buildApiConversationPath} rather than
 * interpolating the template themselves.
 */
export const apiConversationRoute = `${API_PREFIX_V1}/conversations/:conversationId`

/**
 * Builds the concrete item path for one conversation.
 *
 * @param conversationId - Identifier of an existing conversation.
 * @returns The request path addressing that conversation.
 */
export function buildApiConversationPath(conversationId: string): string {
  return `${apiConversationListRoute}/${encodeURIComponent(conversationId)}`
}
