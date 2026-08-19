// This file includes every global constant that @lys/protocol needs.

// ============== API ============== //
/**
 * Versioned prefix embedded in every backend API route path.
 *
 * @remarks This value is transmitted in HTTP request paths and is not a
 * persisted data value. It is release-stable across compatible clients;
 * changing it requires coordinated route updates because URL compatibility
 * would otherwise break.
 */
export const API_PREFIX_V1 = "/api/v1"
// ============== API ============== //

// ============== ENV CONFIG ============== //
/**
 * Loopback interface on which the local Lys backend listens.
 *
 * @remarks This host is embedded in local backend URLs and is not persisted.
 * It is release-stable for compatible desktop/backend pairs; changing it
 * requires coordinated endpoint configuration because connection compatibility
 * would otherwise break.
 */
export const BACKEND_HOST = "127.0.0.1"
/**
 * TCP port on which the local Lys backend listens.
 *
 * @remarks This port number is transmitted in local backend URLs and is not
 * persisted. It is release-stable for compatible desktop/backend pairs;
 * changing it requires coordinated endpoint updates because connections would
 * otherwise target different listeners.
 */
export const BACKEND_PORT = 12345
/**
 * Loopback interface used by the backend to reach LM Studio.
 *
 * @remarks This host is embedded in the backend's LM Studio endpoint and is
 * not persisted. It is release-stable for the local runtime contract; changing
 * it requires coordinated runtime configuration because model operations would
 * otherwise target a different host.
 */
export const LMSTUDIO_HOST = "127.0.0.1"
/**
 * TCP port used by the backend to reach LM Studio.
 *
 * @remarks This port number is transmitted in the backend's LM Studio endpoint
 * and is not persisted. It is release-stable for the local runtime contract;
 * changing it requires coordinated runtime configuration because model
 * operations would otherwise target a different listener.
 */
export const LMSTUDIO_PORT = 1234
// ============== ENV CONFIG ============== //
