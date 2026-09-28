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
 * Versioned PATCH path for stopping every loaded instance of one model key.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because model-unload URL compatibility breaks.
 */
export const apiLlmUnloadModelRoute = `${API_PREFIX_V1}/llm/unload`

/**
 * Versioned GET path for observing whether one canonical model key is loaded.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because model-health URL compatibility breaks.
 */
export const apiLlmTestModelRoute = `${API_PREFIX_V1}/llm/:modelId/health`

/**
 * Versioned GET path for observing the backend's LLM runtime connection status.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because runtime-status URL compatibility breaks. The
 * static `runtime` segment does not shadow `/llm/:modelId/health` for a model
 * whose key is `runtime`.
 */
export const apiLlmRuntimeStatusRoute = `${API_PREFIX_V1}/llm/runtime`

/**
 * Versioned POST path for connecting the backend to its LLM runtime.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because runtime-connect URL compatibility breaks.
 */
export const apiLlmRuntimeConnectRoute = `${API_PREFIX_V1}/llm/runtime/connect`

/**
 * Versioned POST path for the chat SSE endpoint.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because chat URL compatibility breaks.
 */
export const apiChatRoute = `${API_PREFIX_V1}/chat`
