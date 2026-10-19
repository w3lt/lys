import { openVmoResponse } from "./vmoRequest"
import { hasErrorCode } from "./webConnection"

/**
 * Time limit of one health check of vmo, in milliseconds, from sending the
 * request to receiving the answer's status.
 */
export const VMO_HEALTH_TIMEOUT_MS = 1_000

/** Path of vmo's health route. */
const VMO_HEALTH_PATH = "/health"

/** Headers of every health check: plain text accepted, without compression. */
const VMO_HEALTH_REQUEST_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    accept: "text/plain",
    "accept-encoding": "identity"
  })

/**
 * Whether vmo can read pages: `ready` when it answered its health route with
 * `200 OK`, `not-ready` otherwise.
 */
export type VmoHealth = "ready" | "not-ready"

/**
 * Asks vmo, Lys's page reader, whether it can read pages.
 *
 * @param vmoOrigin - Origin of vmo, such as `http://127.0.0.1:8080`.
 * @param timeoutMs - Time limit of the check, in milliseconds.
 * @returns `ready` when vmo answers `GET /health` with `200 OK` within the
 * time limit; `not-ready` for any other status, a refused or broken
 * connection, an answer that is not HTTP, or no answer in time. vmo listens
 * only once it can read pages, so an answer means it is ready.
 * @throws A defect: an origin that is not an `http` URL, or a failure of the
 * request that has no `code`.
 * @remarks Each check opens its own connection, which it closes once the
 * status arrived or the time limit passed, and reads no body. vmo is on this
 * machine, so the address rule for web pages does not apply to it.
 */
export async function sendVmoHealthCheck(
  vmoOrigin: string,
  timeoutMs: number
): Promise<VmoHealth> {
  const target = new URL(VMO_HEALTH_PATH, vmoOrigin)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const opening = openVmoResponse(
    target,
    VMO_HEALTH_REQUEST_HEADERS,
    timeoutSignal
  )
  try {
    const response = await opening
    response.destroy()
    return response.statusCode === 200 ? "ready" : "not-ready"
  } catch (error) {
    // Only failures of the sent request arrive here. Node gives each a code:
    // a system error, an HTTP parser error, or the time limit's abort.
    if (hasErrorCode(error)) return "not-ready"
    throw error
  }
}
