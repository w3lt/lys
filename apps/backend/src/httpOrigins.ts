/**
 * Origins the desktop UI is served from, in development and in the installed
 * application. Shared by the HTTP transport's CORS configuration and the
 * WebSocket routes' origin check, so a new desktop origin is admitted in
 * both at once.
 */
export const DESKTOP_ORIGINS: readonly string[] = Object.freeze([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost"
])

/**
 * Checks whether a request origin may talk to the backend.
 *
 * @param origin - The `Origin` header value, or `undefined` when absent.
 * @returns Whether the origin is one of the desktop origins; a missing
 * origin, as non-browser clients send, is allowed.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true
  return DESKTOP_ORIGINS.includes(origin)
}
