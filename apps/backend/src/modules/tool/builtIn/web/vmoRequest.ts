import { request as requestHttp, type IncomingMessage } from "node:http"
import { addAbortSignal } from "node:stream"

/**
 * Sends one `GET` request to vmo and waits for its response headers.
 *
 * @param target - URL of the route on vmo.
 * @param headers - Headers of the request.
 * @param signal - Aborts the request, and once the headers arrived, the read
 * of the body.
 * @returns The response, whose body the caller owns and must consume or
 * destroy. Once `signal` aborts, a read of the body rejects with an
 * `AbortError` whose `cause` is the signal's reason.
 * @throws Synchronously, before anything is sent, when Node cannot build the
 * request, such as for a target that is not an `http` URL. The promise
 * rejects with the request's failure, a Node.js error with a `code`, such as
 * `ECONNREFUSED` when nothing listens on vmo's port, `ECONNRESET` when the
 * connection breaks, or an `HPE_*` code for an answer that is not HTTP; once
 * `signal` aborts, it rejects with an `AbortError` whose `cause` is the
 * signal's reason.
 * @remarks Each request opens its own connection, which ends when the body is
 * consumed or destroyed. vmo is on this machine, so the address rule for web
 * pages does not apply to it.
 */
export function openVmoResponse(
  target: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<IncomingMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>()
  const outgoing = requestHttp(
    target,
    { method: "GET", headers, agent: false, signal },
    (response) => resolve(addAbortSignal(signal, response))
  )
  // Stays attached: a failure after the response arrived, such as the socket
  // closing when the body is destroyed, must not go unhandled. The promise is
  // settled by then, so rejecting again changes nothing.
  outgoing.on("error", reject)
  outgoing.end()
  return promise
}
