import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for listing one provider's models.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because list-model URL compatibility breaks.
 */
export const apiLlmListModelsRoute = `${API_PREFIX_V1}/llm/:provider/list`
/**
 * Versioned POST path for loading one model of one provider.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because model-load URL compatibility breaks.
 */
export const apiLlmLoadModelRoute = `${API_PREFIX_V1}/llm/:provider/load`

/**
 * Versioned PATCH path for stopping every loaded instance of one model key
 * of one provider.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because model-unload URL compatibility breaks.
 */
export const apiLlmUnloadModelRoute = `${API_PREFIX_V1}/llm/:provider/unload`

/**
 * Versioned GET path for observing whether one canonical model key of one
 * provider is loaded.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because model-health URL compatibility breaks.
 */
export const apiLlmTestModelRoute = `${API_PREFIX_V1}/llm/:provider/:modelId/health`

/**
 * Versioned GET path for observing the backend's connection status to one
 * provider's LLM runtime.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because runtime-status URL compatibility breaks. The
 * static `runtime` segment does not shadow `/llm/:provider/:modelId/health`
 * for a model whose key is `runtime`.
 */
export const apiLlmRuntimeStatusRoute = `${API_PREFIX_V1}/llm/:provider/runtime`

/**
 * Versioned POST path for connecting the backend to one provider's LLM runtime.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because runtime-connect URL compatibility breaks.
 */
export const apiLlmRuntimeConnectRoute = `${API_PREFIX_V1}/llm/:provider/runtime/connect`

/**
 * Every LLM route path above starts its own part with a `:provider` segment,
 * the provider the request is for, which {@link buildLlmProviderApiPath}
 * fills in.
 */

/**
 * Versioned POST path for the chat SSE endpoint.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires coordinated
 * route registration because chat URL compatibility breaks.
 */
export const apiChatRoute = `${API_PREFIX_V1}/chat`
