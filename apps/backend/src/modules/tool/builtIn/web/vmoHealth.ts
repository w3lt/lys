import { request as requestHttp, type RequestOptions } from "node:http"
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
 * Sends one health check to vmo and waits for the answer's status.
 *
 * @param target - URL of vmo's health route.
 * @param signal - Ends the check when its time is up.
 * @returns The HTTP status of vmo's answer, whose body is destroyed unread.
 * @throws The request's failure, such as `ECONNREFUSED` when nothing listens
 * on vmo's port, or the abort once `signal` aborts.
 */
function readVmoHealthStatus(
  target: URL,
  signal: AbortSignal
): Promise<number> {
  const options: RequestOptions = {
    method: "GET",
    headers: VMO_HEALTH_REQUEST_HEADERS,
    agent: false,
    signal
  }
  return new Promise((resolve, reject) => {
    const outgoing = requestHttp(target, options, (response) => {
      resolve(response.statusCode ?? 0)
      response.destroy()
    })
    // Stays attached: destroying the body can fail the request after the
    // status settled the promise, and rejecting again changes nothing.
    outgoing.on("error", reject)
    outgoing.end()
  })
}

/**
 * Asks vmo, Lys's page reader, whether it can read pages.
 *
 * @param vmoOrigin - Origin of vmo, such as `http://127.0.0.1:8080`.
 * @param timeoutMs - Time limit of the check, in milliseconds.
 * @returns `ready` when vmo answers `GET /health` with `200 OK` within the
 * time limit; `not-ready` for any other status, a refused or broken
 * connection, or no answer in time. vmo listens only once it can read pages,
 * so an answer means it is ready.
 * @throws Any failure without a system error code, which is a defect.
 * @remarks Each check opens its own connection and reads no body. vmo is on
 * this machine, so the address rule for web pages does not apply to it.
 */
export async function sendVmoHealthCheck(
  vmoOrigin: string,
  timeoutMs: number
): Promise<VmoHealth> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  try {
    const status = await readVmoHealthStatus(
      new URL(VMO_HEALTH_PATH, vmoOrigin),
      timeoutSignal
    )
    return status === 200 ? "ready" : "not-ready"
  } catch (error) {
    if (timeoutSignal.aborted || hasErrorCode(error)) return "not-ready"
    throw error
  }
}
