import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for listing downloaded LM Studio models.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because list-model URL compatibility breaks.
 */
export const apiLlmListModelsRoute = `${API_PREFIX_V1}/llm/list`
/**
 * Versioned POST path for loading one LM Studio model.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because model-load URL compatibility breaks.
 */
export const apiLlmLoadModelRoute = `${API_PREFIX_V1}/llm/load`

/**
 * Versioned POST path for the chat SSE endpoint.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because chat URL compatibility breaks.
 */
export const apiChatRoute = `${API_PREFIX_V1}/chat`
