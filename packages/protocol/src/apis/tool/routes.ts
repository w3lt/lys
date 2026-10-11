import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for listing the tools the backend runs.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires
 * coordinated route registration because tool-list URL compatibility breaks.
 */
export const apiToolsRoute = `${API_PREFIX_V1}/tools`
