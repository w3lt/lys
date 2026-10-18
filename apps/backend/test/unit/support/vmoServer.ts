import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { onTestFinished } from "vitest"
import type { PageRenderingDependencies } from "../../../src/modules/tool/builtIn/web/pageRendering"
import {
  parsePageUrl,
  type PageUrl
} from "../../../src/modules/tool/builtIn/web/pageUrl"
import { isBlockedAddress } from "../../../src/modules/tool/builtIn/web/webAddresses"
import type { HostAddressLookup } from "../../../src/modules/tool/builtIn/web/webConnection"

/** One request a fake vmo received. */
export type ReceivedVmoRequest = Readonly<{
  /** HTTP method. */
  method: string
  /** Request target: path and query, such as `/web/read-page?url=…`. */
  path: string
  /** Request headers, lowercased by Node. */
  headers: IncomingHttpHeaders
}>

/** Answers one request a fake vmo received. */
export type VmoRoute = (
  request: IncomingMessage,
  response: ServerResponse
) => void

/** Local server standing in for vmo. */
export type VmoServer = Readonly<{
  /** Origin of the server, such as `http://127.0.0.1:50123`. */
  origin: string
  /** Every request the server received, in arrival order. */
  receivedRequests: readonly ReceivedVmoRequest[]
}>

/** `Content-Type` of every JSON answer vmo sends. */
export const VMO_JSON_CONTENT_TYPE = "application/json; charset=utf-8"

/** Settings of a read through a fake vmo that a case may change. */
export type VmoReadOptions = Readonly<{
  /** Host lookup; {@link listTestHostAddresses} when omitted. */
  lookupHostAddresses?: HostAddressLookup
  /** Receives why the read failed; ignored when omitted. */
  reportPageReaderFailure?: (failure: unknown) => void
  /** Time limit of the whole read; 5 seconds when omitted. */
  readTimeoutMs?: number
}>

/**
 * Lists the addresses of the test host names: `pages.test` has a public
 * address, `private.test` a private one, and every other name has none.
 *
 * @param hostname - Host name to look up.
 * @returns A promise of the name's addresses; rejected with an `ENOTFOUND`
 * error for a name without any.
 */
export const listTestHostAddresses: HostAddressLookup = (hostname) => {
  switch (hostname) {
    case "pages.test":
      return Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    case "private.test":
      return Promise.resolve([{ address: "10.0.0.7", family: 4 }])
    default:
      return Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: "ENOTFOUND"
        })
      )
  }
}

/**
 * Listens on a free loopback port, closing the server with its connections
 * when the current test finishes.
 *
 * @param server - HTTP server.
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
 * Starts a fake vmo on a free loopback port, closed with its connections
 * when the current test finishes.
 *
 * @param route - Answers each request.
 * @returns The server's origin and the requests it receives.
 */
export async function startVmoServer(route: VmoRoute): Promise<VmoServer> {
  const receivedRequests: ReceivedVmoRequest[] = []
  const server = createServer((request, response) => {
    receivedRequests.push(
      Object.freeze({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers
      })
    )
    route(request, response)
  })
  const port = await listenOnLoopback(server)
  return Object.freeze({ origin: `http://127.0.0.1:${port}`, receivedRequests })
}

/**
 * Finds the origin of a loopback port nothing listens on.
 *
 * @returns The origin of a port a server listened on and then closed, so a
 * connection to it is refused.
 */
export async function findClosedVmoOrigin(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

/**
 * Builds the dependencies of a read through a fake vmo.
 *
 * @param vmoOrigin - Origin of the fake vmo.
 * @param options - Settings the case changes.
 * @returns Frozen dependencies with the production address rule, under
 * which `pages.test` may be read, `private.test` is a private address, and
 * every other host name has no address.
 */
export function buildVmoReadDependencies(
  vmoOrigin: string,
  options: VmoReadOptions = {}
): PageRenderingDependencies {
  return Object.freeze({
    lookupHostAddresses: options.lookupHostAddresses ?? listTestHostAddresses,
    isBlockedAddress,
    reportPageReaderFailure:
      options.reportPageReaderFailure ?? (() => undefined),
    vmoOrigin,
    readTimeoutMs: options.readTimeoutMs ?? 5_000
  })
}

/**
 * Builds a checked page URL.
 *
 * @param text - URL text that passes the page URL rules.
 * @returns The checked URL.
 */
export function buildTestPageUrl(text: string): PageUrl {
  const parsed = parsePageUrl(text)
  if (parsed.status !== "valid") throw new Error("Invalid test page URL")
  return parsed.url
}

/**
 * Builds a route that answers with a body.
 *
 * @param status - HTTP status.
 * @param contentType - `Content-Type` header.
 * @param body - Body bytes or text.
 * @param headers - Extra or replacing headers.
 * @returns The route.
 */
export function answerWithBody(
  status: number,
  contentType: string,
  body: string | Uint8Array,
  headers: Readonly<Record<string, string>> = {}
): VmoRoute {
  return (_request, response) => {
    response.statusCode = status
    response.setHeader("content-type", contentType)
    for (const [name, value] of Object.entries(headers))
      response.setHeader(name, value)
    response.end(body)
  }
}

/**
 * Builds a route that answers like vmo with the HTML of a page it read.
 *
 * @param html - HTML of the page.
 * @param isTruncated - Whether vmo cut the HTML; false by default.
 * @returns The route, answering `200 OK` with vmo's JSON answer.
 */
export function answerWithPage(html: string, isTruncated = false): VmoRoute {
  return answerWithBody(
    200,
    VMO_JSON_CONTENT_TYPE,
    JSON.stringify({ html, isTruncated })
  )
}
