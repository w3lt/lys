import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned health-check path, currently retained as the `/heath` route string.
 *
 * @remarks This path is transmitted in health requests and is not persisted.
 * It is release-stable across compatible backend clients; changing it requires
 * coordinated route registration because health-check URL compatibility breaks.
 */
export const apiHeathCheckRoute = `${API_PREFIX_V1}/heath`
