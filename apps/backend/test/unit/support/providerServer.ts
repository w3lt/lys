import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { onTestFinished } from "vitest"

/** One request the fake provider received. */
export type ProviderServerRequest = Readonly<{
  /** HTTP method. */
  method: string
  /** Path, without the query. */
  path: string
  /** `Authorization` header, if any. */
  authorization: string | undefined
  /** Parsed JSON body, or undefined without one. */
  body: unknown
}>

/** Answer of one fake provider route. */
export type ProviderServerAnswer = Readonly<{
  /** HTTP status. */
  status: number
  /** Value sent as the JSON body. */
  body: unknown
}>

/**
 * Answers one request; keyed by `<METHOD> <path>` in a route table.
 *
 * @param request - The received request.
 * @returns The answer to send, or a promise of it, which holds the request
 * open until it settles.
 */
export type ProviderServerRoute = (
  request: ProviderServerRequest
) => ProviderServerAnswer | Promise<ProviderServerAnswer>

/** A fake provider listening on loopback for the current test. */
export type ProviderServer = Readonly<{
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  baseUrl: string
  /** Every request received, in arrival order. */
  requests: readonly ProviderServerRequest[]
}>

/**
 * Starts a fake provider HTTP server owned by the current test.
 *
 * @param routes - Answers keyed by `<METHOD> <path>`, such as `GET /api/tags`;
 * a request without a route answers 404.
 * @returns The server's base URL and its request log; it closes when the
 * test finishes.
 */
export async function startProviderServer(
  routes: Readonly<Record<string, ProviderServerRoute>>
): Promise<ProviderServer> {
  const requests: ProviderServerRequest[] = []
  const server = createServer((incoming, outgoing) => {
    void readRequest(incoming).then(async (request) => {
      requests.push(request)
      const route = routes[`${request.method} ${request.path}`]
      const answer = (await route?.(request)) ?? {
        status: 404,
        body: { error: "no" }
      }
      outgoing.writeHead(answer.status, { "content-type": "application/json" })
      outgoing.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(
    async () =>
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const { port } = server.address() as AddressInfo
  return Object.freeze({ baseUrl: `http://127.0.0.1:${port}`, requests })
}

/**
 * Reads the path of a request target.
 *
 * @param target - Request target, a path with an optional query.
 * @returns The target up to its first `?`, or the whole target without one.
 */
function readRequestPath(target: string): string {
  const queryStart = target.indexOf("?")
  return queryStart === -1 ? target : target.slice(0, queryStart)
}

/**
 * Reads one received request whole.
 *
 * @param incoming - Request stream.
 * @returns The request, with its JSON body parsed when it has one.
 */
async function readRequest(
  incoming: IncomingMessage
): Promise<ProviderServerRequest> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8")
  return Object.freeze({
    method: incoming.method ?? "",
    path: readRequestPath(incoming.url ?? "/"),
    authorization: incoming.headers.authorization,
    body: text === "" ? undefined : (JSON.parse(text) as unknown)
  })
}

/**
 * Builds a route that always gives one answer.
 *
 * @param body - JSON body of the answer.
 * @param status - HTTP status; 200 when omitted.
 * @returns The route.
 */
export function answerWith(body: unknown, status = 200): ProviderServerRoute {
  return () => ({ status, body })
}
