import { tavilyApiKeySchema } from "@lys/share"
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http"
import {
  createServer as createTlsServer,
  type ServerOptions as TlsServerOptions
} from "node:https"
import type { AddressInfo } from "node:net"
import { onTestFinished } from "vitest"
import type { TavilyRequestDependencies } from "../../../src/modules/tool/builtIn/web/tavilyRequest"
import type { HostAddressLookup } from "../../../src/modules/tool/builtIn/web/webConnection"
import { createSelfSignedTlsCredentials } from "./selfSignedCertificate"

/** One request a fake Tavily server received, with its whole body. */
export type ReceivedTavilyRequest = Readonly<{
  /** HTTP method. */
  method: string
  /** Request path, such as `/search`. */
  path: string
  /** Request headers, lowercased by Node. */
  headers: IncomingHttpHeaders
  /** Body as UTF-8 text; empty for a request without one. */
  body: string
}>

/** Answers one request a fake Tavily server received. */
export type TavilyRoute = (
  request: ReceivedTavilyRequest,
  response: ServerResponse
) => void

/** Local server standing in for the Tavily API. */
export type TavilyServer = Readonly<{
  /** Request dependencies that reach this server and block no address. */
  dependencies: TavilyRequestDependencies
  /** Every request the server received, in arrival order. */
  receivedRequests: readonly ReceivedTavilyRequest[]
}>

/** Synthetic Tavily API key; not a real credential. */
export const TEST_TAVILY_API_KEY = tavilyApiKeySchema.parse(
  "tvly-synthetic-test-key"
)

/** Lookup that sends every host name to the loopback address. */
const lookupLoopback: HostAddressLookup = () =>
  Promise.resolve([{ address: "127.0.0.1", family: 4 }])

/** TLS settings of a fake Tavily server besides its key and certificate. */
export type TavilyServerTlsOptions = Pick<
  TlsServerOptions,
  "minVersion" | "maxVersion" | "ciphers"
>

/**
 * Builds the request listener of a fake Tavily server.
 *
 * @param receivedRequests - Record every request is appended to.
 * @param route - Answers each request once its body has arrived.
 * @returns The listener.
 */
function createTavilyRequestListener(
  receivedRequests: ReceivedTavilyRequest[],
  route: TavilyRoute
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const received: ReceivedTavilyRequest = Object.freeze({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8")
      })
      receivedRequests.push(received)
      route(received, response)
    })
  }
}

/**
 * Listens on a free loopback port, closing the server with its connections
 * when the current test finishes.
 *
 * @param server - HTTP or HTTPS server.
 * @returns The port.
 */
async function listenOnLoopback(server: Server): Promise<number> {
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

/**
 * Builds request dependencies that reach a fake server on the loopback port.
 *
 * @param origin - Origin under the host name `tavily.test`.
 * @returns Frozen dependencies with a 5-second time limit that block no
 * address.
 */
function buildTestTavilyDependencies(
  origin: string
): TavilyRequestDependencies {
  return Object.freeze({
    origin,
    lookupHostAddresses: lookupLoopback,
    isBlockedAddress: () => false,
    requestTimeoutMs: 5_000
  })
}

/**
 * Starts a fake Tavily server on a free loopback port, closed with its
 * connections when the current test finishes.
 *
 * @param route - Answers each request once its body has arrived.
 * @returns Dependencies that reach the server under the host name
 * `tavily.test`, a 5-second time limit, and the received requests.
 */
export async function startTavilyServer(
  route: TavilyRoute
): Promise<TavilyServer> {
  const receivedRequests: ReceivedTavilyRequest[] = []
  const server = createServer(
    createTavilyRequestListener(receivedRequests, route)
  )
  const port = await listenOnLoopback(server)
  const dependencies = buildTestTavilyDependencies(`http://tavily.test:${port}`)
  return Object.freeze({ dependencies, receivedRequests })
}

/**
 * Starts a fake Tavily server over HTTPS with a fresh self-signed
 * certificate for `tavily.test`, closed when the current test finishes.
 *
 * @param route - Answers each request once its body has arrived.
 * @param tlsOptions - Protocol versions and ciphers the server accepts;
 * Node's defaults when omitted.
 * @returns Dependencies that reach the server over `https:` and the
 * received requests. No client that verifies certificates trusts it.
 */
export async function startTlsTavilyServer(
  route: TavilyRoute,
  tlsOptions: TavilyServerTlsOptions = {}
): Promise<TavilyServer> {
  const receivedRequests: ReceivedTavilyRequest[] = []
  const server = createTlsServer(
    { ...createSelfSignedTlsCredentials("tavily.test"), ...tlsOptions },
    createTavilyRequestListener(receivedRequests, route)
  )
  const port = await listenOnLoopback(server)
  const dependencies = buildTestTavilyDependencies(
    `https://tavily.test:${port}`
  )
  return Object.freeze({ dependencies, receivedRequests })
}

/**
 * Builds a route that answers with a JSON body.
 *
 * @param body - Value sent as JSON, or exact text when it is a string.
 * @param status - HTTP status; 200 by default.
 * @param headers - Extra or replacing headers.
 * @returns The route.
 */
export function answerWithJson(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
): TavilyRoute {
  return (_request, response) => {
    response.statusCode = status
    response.setHeader("content-type", "application/json")
    for (const [name, value] of Object.entries(headers))
      response.setHeader(name, value)
    response.end(typeof body === "string" ? body : JSON.stringify(body))
  }
}
