import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for listing the tools the backend runs.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires
 * coordinated route registration because tool-list URL compatibility breaks.
 */
export const apiToolsRoute = `${API_PREFIX_V1}/tools`

/**
 * Name the model calls the web search tool by, and the path segment of its
 * key check.
 *
 * @remarks Transmitted in tool definitions, tool-call events, and HTTP paths;
 * not persisted. Changing it renames the tool for models, Settings, and the
 * desktop's approval card, and requires coordinated consumers.
 */
export const WEB_SEARCH_TOOL_NAME = "web_search"

/**
 * Versioned GET path for checking the saved Tavily API key with Tavily.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires
 * coordinated route registration.
 */
export const apiWebSearchKeyCheckRoute = `${apiToolsRoute}/${WEB_SEARCH_TOOL_NAME}/key-check`
