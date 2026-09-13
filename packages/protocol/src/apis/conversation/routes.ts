import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for listing stored conversations.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires
 * coordinated route registration because list URL compatibility breaks.
 */
export const apiConversationsRoute = `${API_PREFIX_V1}/conversations`

/**
 * Versioned path addressing one stored conversation by its UUIDv7 identifier.
 *
 * @remarks The get, title-update, and delete endpoints share this path and
 * are distinguished by HTTP method. Consumers substitute a percent-encoded
 * identifier for `:conversationId`. Changing it requires coordinated route
 * registration because conversation URL compatibility breaks.
 */
export const apiConversationRoute = `${API_PREFIX_V1}/conversations/:conversationId`
