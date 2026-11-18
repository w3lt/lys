import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for following, over SSE, the replies the backend
 * started and the jobs they belong to.
 *
 * @remarks This path is transmitted in HTTP requests and is not persisted.
 * Changing it requires coordinated route registration because
 * activity-events URL compatibility breaks.
 */
export const apiActivityEventsRoute = `${API_PREFIX_V1}/activity/events`
