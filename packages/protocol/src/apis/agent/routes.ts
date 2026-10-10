import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned path for listing agents and creating new stored ones.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted. The
 * list and create endpoints share it and are distinguished by HTTP method.
 * Changing it requires coordinated route registration because agent URL
 * compatibility breaks.
 */
export const apiAgentsRoute = `${API_PREFIX_V1}/agents`

/**
 * Versioned path addressing one built-in or stored agent by its code.
 *
 * @remarks The get, update, and delete endpoints share this path and are
 * distinguished by HTTP method. Consumers substitute the agent code for
 * `:agentCode`; a valid code needs no percent-encoding. The create endpoint's
 * `Location` header is this path with the new agent's code. Changing it
 * requires coordinated route registration because agent URL compatibility
 * breaks.
 */
export const apiAgentRoute = `${API_PREFIX_V1}/agents/:agentCode`
