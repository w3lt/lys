import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { onTestFinished } from "vitest"
import type { PageRenderingDependencies } from "../../../src/modules/tool/builtIn/web/pageRendering"
import {
  parsePageUrl,
  type PageUrl
} from "../../../src/modules/tool/builtIn/web/pageUrl"
import type { HostAddressLookup } from "../../../src/modules/tool/builtIn/web/webConnection"
import { readTestBrowserExecutablePath } from "./pageBrowser"

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
  /** Remote address of every TCP connection the server accepted, in order. */
  acceptedConnections: readonly string[]
}>

/**
 * Resolves the test host names: `pages.test` reaches the local page servers,
 * `private.test` has a private address, and every other name has none.
 */
const lookupTestHost: HostAddressLookup = async (hostname) => {
  switch (hostname) {
    case "pages.test":
      return [{ address: "127.0.0.1", family: 4 }]
    case "private.test":
      return [{ address: "10.0.0.7", family: 4 }]
    default:
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: "ENOTFOUND"
      })
  }
}

/** Settings of a read of a test page server that a case may change. */
export type PageServerReadOptions = Readonly<{
  /** Browser to start; the test browser when omitted. */
  browserExecutablePath?: string
  /** Time limit of the whole read; 10 seconds when omitted. */
  readTimeoutMs?: number
  /** Most time waiting for the network to go quiet; 1 second when omitted. */
  settleTimeoutMs?: number
  /** Address rule; only the loopback address of the page servers when omitted. */
  isBlockedAddress?: (address: string) => boolean
}>

/**
 * Builds the dependencies of a browser read of test page servers.
 *
 * @param options - Settings the case changes.
 * @returns Dependencies under which `pages.test` reaches the local page
 * servers, `private.test` is a private address, every other host name has no
 * address, and only 127.0.0.1 may be reached.
 * @throws When no test browser is set and the case does not name one.
 */
export function buildPageServerDependencies(
  options: PageServerReadOptions = {}
): PageRenderingDependencies {
  return Object.freeze({
    lookupHostAddresses: lookupTestHost,
    isBlockedAddress:
      options.isBlockedAddress ??
      ((address: string) => address !== "127.0.0.1"),
    browserExecutablePath:
      options.browserExecutablePath ?? readTestBrowserExecutablePath(),
    readTimeoutMs: options.readTimeoutMs ?? 10_000,
    settleTimeoutMs: options.settleTimeoutMs ?? 1_000
  })
}

/**
 * Starts a page server on a free loopback port, closed with its connections
 * when the current test finishes.
 *
 * @param route - Answers each request.
 * @returns The server's port, the headers it receives, and the connections it
 * accepts.
 */
export async function startPageServer(route: PageRoute): Promise<PageServer> {
  const receivedHeaders: IncomingHttpHeaders[] = []
  const acceptedConnections: string[] = []
  const server = createServer((request, response) => {
    receivedHeaders.push(request.headers)
    route(request, response)
  })
  server.on("connection", (socket) =>
    acceptedConnections.push(socket.remoteAddress ?? "")
  )
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { port, receivedHeaders, acceptedConnections }
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
