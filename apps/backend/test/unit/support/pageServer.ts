import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { onTestFinished } from "vitest"
import type {
  HostAddressLookup,
  PageRequestDependencies
} from "../../../src/modules/tool/builtIn/web/pageRequest"
import {
  parsePageUrl,
  type PageUrl
} from "../../../src/modules/tool/builtIn/web/pageUrl"

/** Answers one request a test page server receives. */
export type PageRoute = (
  request: IncomingMessage,
  response: ServerResponse
) => void

/** Local server standing in for a website. */
export type PageServer = Readonly<{
  /** Port the server listens on, on the loopback address. */
  port: number
  /** Headers of every request the server received, in arrival order. */
  receivedHeaders: readonly IncomingHttpHeaders[]
}>

/** Lookup that sends every host name to the loopback address. */
const lookupLoopback: HostAddressLookup = async () => [
  { address: "127.0.0.1", family: 4 }
]

/**
 * Dependencies of a request to a test page server: every host name reaches
 * the loopback address, and no address is blocked.
 */
export const PAGE_SERVER_DEPENDENCIES: PageRequestDependencies = Object.freeze({
  lookupHostAddresses: lookupLoopback,
  isBlockedAddress: () => false,
  requestTimeoutMs: 5_000
})

/**
 * Starts a page server on a free loopback port, closed with its connections
 * when the current test finishes.
 *
 * @param route - Answers each request.
 * @returns The server's port and the headers it receives.
 */
export async function startPageServer(route: PageRoute): Promise<PageServer> {
  const receivedHeaders: IncomingHttpHeaders[] = []
  const server = createServer((request, response) => {
    receivedHeaders.push(request.headers)
    route(request, response)
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { port, receivedHeaders }
}

/**
 * Builds the checked URL of a path on a test page server.
 *
 * @param port - Port of the server.
 * @param path - Absolute path on the server.
 * @returns The URL, under a host name the test lookup sends to the server.
 */
export function buildTestPageUrl(port: number, path: string): PageUrl {
  const parsed = parsePageUrl(`http://pages.test:${port}${path}`)
  if (parsed.status !== "valid") throw new Error("Invalid test page URL")
  return parsed.url
}

/**
 * Builds a route that answers with one body.
 *
 * @param contentType - `Content-Type` header, or undefined to send none.
 * @param body - Body bytes or text.
 * @param headers - Extra headers.
 * @returns The route.
 */
export function answerWithBody(
  contentType: string | undefined,
  body: string | Uint8Array,
  headers: Readonly<Record<string, string>> = {}
): PageRoute {
  return (_request, response) => {
    if (contentType !== undefined)
      response.setHeader("content-type", contentType)
    for (const [name, value] of Object.entries(headers))
      response.setHeader(name, value)
    response.end(body)
  }
}
