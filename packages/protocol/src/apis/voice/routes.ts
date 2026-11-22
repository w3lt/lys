import { API_PREFIX_V1 } from "../../constant"

/**
 * Versioned GET path for the WebSocket that carries one dictation.
 *
 * @remarks This path is transmitted in HTTP upgrade requests and is not
 * persisted. It has no parameters. Changing it requires coordinated route
 * registration.
 */
export const apiVoiceDictationRoute = `${API_PREFIX_V1}/voice/dictation`
