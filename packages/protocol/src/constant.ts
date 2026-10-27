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
 * Host of LM Studio's default address, used while the person has saved no
 * LM Studio address in Settings.
 *
 * @remarks The backend reaches LM Studio at the saved address, or at this
 * host and {@link LMSTUDIO_PORT}; the desktop shows the pair as the address
 * field's placeholder. It is not persisted: the settings file stores `null`
 * for the default. Changing it moves where Lys looks for LM Studio for every
 * person who saved no address.
 */
export const LMSTUDIO_HOST = "127.0.0.1"
/**
 * Port of LM Studio's default address, paired with {@link LMSTUDIO_HOST}.
 *
 * @remarks Same ownership and persistence as {@link LMSTUDIO_HOST}.
 */
export const LMSTUDIO_PORT = 1234
/**
 * Host of a local Ollama server's default address, used while the person has
 * saved no Ollama address in Settings.
 *
 * @remarks The backend reaches a local Ollama server at the saved address, or
 * at this host and {@link OLLAMA_PORT}; the desktop shows the pair as the
 * address field's placeholder. It is not persisted: the settings file stores
 * `null` for the default. Changing it moves where Lys looks for Ollama for
 * every person who saved no address.
 */
export const OLLAMA_HOST = "127.0.0.1"
/**
 * Port of a local Ollama server's default address, paired with
 * {@link OLLAMA_HOST}.
 *
 * @remarks Same ownership and persistence as {@link OLLAMA_HOST}.
 */
export const OLLAMA_PORT = 11434
/**
 * Loopback interface on which vmo, Lys's page reader, listens.
 *
 * @remarks The backend sends every page read and health check to this host,
 * and the desktop names it on vmo's card. It is not persisted. vmo's
 * `WebServer` in `apps/vmo` declares it again as its default host, and
 * `VMO_ADDRESS` in the desktop's Tauri host, which checks vmo's health, as
 * its host, under an approved CONST-005 exception: Swift and Rust cannot
 * import it. The desktop unit test `vmo-address.test.ts` fails when either
 * copy differs, so changing it requires changing all three together.
 */
export const VMO_HOST = "127.0.0.1"
/**
 * TCP port on which vmo, Lys's page reader, listens.
 *
 * @remarks The backend sends every page read and health check to this port,
 * and the desktop names it on vmo's card. It is not persisted. vmo's
 * `WebServer` in `apps/vmo` declares it again as its default port, and
 * `VMO_ADDRESS` in the desktop's Tauri host as its port, under the same
 * CONST-005 exception as {@link VMO_HOST}, checked by the same test, so
 * changing it requires changing all three together.
 */
export const VMO_PORT = 8080
// ============== ENV CONFIG ============== //

// ============== EXTERNAL SERVICES ============== //
/**
 * Host of the Tavily Search API, the only service the `web_search` tool sends
 * queries to.
 *
 * @remarks The backend sends every Tavily request to `https://` followed by
 * this host, and the desktop's approval card names it as where a query goes,
 * so both read this one value. It is not persisted. Changing it changes where
 * queries and the person's Tavily API key are sent and requires a coordinated
 * desktop and backend release.
 */
export const TAVILY_API_HOST = "api.tavily.com"
/**
 * Host of Ollama's cloud service, the only place requests go while Ollama is
 * the active provider in cloud mode.
 *
 * @remarks The backend sends model listings and chat requests, with the
 * person's Ollama API key, to `https://` followed by this host, and the
 * desktop's Providers pane names it as where requests go. It is not
 * persisted. Changing it changes where conversations and the key are sent
 * and requires a coordinated desktop and backend release.
 */
export const OLLAMA_CLOUD_API_HOST = "ollama.com"
/**
 * Host of Groq's API, the only place requests go while Groq is the active
 * provider.
 *
 * @remarks The backend sends model listings and chat requests, with the
 * person's Groq API key, to `https://` followed by this host, and the
 * desktop's Providers pane names it as where requests go. It is not
 * persisted. Changing it changes where conversations and the key are sent
 * and requires a coordinated desktop and backend release.
 */
export const GROQ_API_HOST = "api.groq.com"
// ============== EXTERNAL SERVICES ============== //
