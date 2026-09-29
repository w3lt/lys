import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for following one assistant reply's generation over SSE.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted.
 * Consumers substitute percent-encoded UUIDv7 identifiers for
 * `:conversationId` and `:assistantMessageId`. Changing it requires
 * coordinated route registration because reply-events URL compatibility
 * breaks.
 */
export const apiChatReplyEventsRoute = `${API_PREFIX_V1}/chat/:conversationId/replies/:assistantMessageId/events`

/**
 * Versioned POST path for stopping one assistant reply's running generation.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted.
 * Consumers substitute percent-encoded UUIDv7 identifiers for
 * `:conversationId` and `:assistantMessageId`. Changing it requires
 * coordinated route registration because reply-stop URL compatibility breaks.
 */
export const apiChatReplyStopRoute = `${API_PREFIX_V1}/chat/:conversationId/replies/:assistantMessageId/stop`
