import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for listing the MCP servers the backend applied, with
 * each one's connection state.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires
 * coordinated route registration.
 */
export const apiMcpServersRoute = `${API_PREFIX_V1}/mcp/servers`

/**
 * Versioned POST path for applying the `mcp` settings group again.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. It
 * is release-stable across compatible clients; changing it requires
 * coordinated route registration.
 */
export const apiMcpServersSyncRoute = `${apiMcpServersRoute}/sync`

/**
 * Versioned POST path for closing one MCP server's connection and opening
 * it again.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted.
 * Consumers substitute the server name for `:serverName`; a valid name needs
 * no percent-encoding. It is release-stable across compatible clients;
 * changing it requires coordinated route registration.
 */
export const apiMcpServerReconnectRoute = `${apiMcpServersRoute}/:serverName/reconnect`
