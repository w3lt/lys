import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage
} from "node:http"
import { connect, type Socket } from "node:net"
import { describe, expect, it, onTestFinished } from "vitest"
import PageProxy, {
  type PageProxyCredentials,
  type PageProxyDependencies,
  type PageProxyLimits
} from "../../../../../../src/modules/tool/builtIn/web/pageProxy"
import type { HostAddressLookup } from "../../../../../../src/modules/tool/builtIn/web/webConnection"
import { answerWithBody, startPageServer } from "../../../../support/pageServer"

/** Limits no test reaches unless it lowers them. */
const GENEROUS_LIMITS: PageProxyLimits = Object.freeze({
  maximumConnections: 16,
  maximumReceivedBytes: 1024 * 1024
})

/**
 * Resolves the test host names: `pages.test` reaches the local page servers,
 * `private.test` has a private address, and `missing.test` has none.
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

/** Reaches the local page servers and blocks every other address. */
const LOOPBACK_ONLY_DEPENDENCIES: PageProxyDependencies = Object.freeze({
  lookupHostAddresses: lookupTestHost,
  isBlockedAddress: (address: string) => address !== "127.0.0.1",
  limits: GENEROUS_LIMITS
})

/** What a CONNECT request through the proxy came to. */
type ConnectOutcome =
  | Readonly<{ status: "connected"; socket: Socket }>
  | Readonly<{
      status: "answered"
      statusCode: number
      headers: IncomingHttpHeaders
    }>
  | Readonly<{ status: "refused" }>

/** What a forwarded request through the proxy came to. */
type ForwardOutcome =
  | Readonly<{ status: "answered"; statusCode: number; body: string }>
  | Readonly<{ status: "refused" }>

/**
 * Opens a proxy that the test closes when it finishes.
 *
 * @param dependencies - Lookup, address rule, and limits of the proxy.
 * @returns The ready proxy.
 */
async function openTestProxy(
  dependencies: PageProxyDependencies = LOOPBACK_ONLY_DEPENDENCIES
): Promise<PageProxy> {
  const proxy = await PageProxy.open(dependencies)
  onTestFinished(() => proxy.close())
  return proxy
}

/**
 * Formats the header value that carries proxy credentials.
 *
 * @param credentials - Username and password to send.
 * @returns A Basic authorization value.
 */
function formatProxyAuthorization(credentials: PageProxyCredentials): string {
  const token = Buffer.from(
    `${credentials.username}:${credentials.password}`
  ).toString("base64")
  return `Basic ${token}`
}

/**
 * Finds the port a proxy listens on.
 *
 * @param proxy - Ready proxy.
 * @returns The port of its URL.
 */
function findProxyPort(proxy: PageProxy): number {
  return Number(new URL(proxy.url).port)
}

/**
 * Builds what a CONNECT request came to once the proxy answered it.
 *
 * @param response - The proxy's answer.
 * @param socket - Connection the answer arrived on; the test destroys it
 * when it finishes.
 * @returns The open tunnel for a 200 answer, otherwise the answer.
 */
function buildConnectOutcome(
  response: IncomingMessage,
  socket: Socket
): ConnectOutcome {
  onTestFinished(() => {
    socket.destroy()
  })
  if (response.statusCode === 200) return { status: "connected", socket }
  return {
    status: "answered",
    statusCode: response.statusCode ?? 0,
    headers: response.headers
  }
}

/**
 * Sends one CONNECT request to a proxy.
 *
 * @param proxy - Proxy to send it to.
 * @param target - `host:port` to tunnel to.
 * @param authorization - Proxy-Authorization value, or undefined to send none.
 * @returns The open tunnel, the proxy's answer, or `refused` when the proxy
 * closed the connection without one.
 */
function sendConnect(
  proxy: PageProxy,
  target: string,
  authorization: string | undefined
): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    const headers =
      authorization === undefined
        ? {}
        : { "proxy-authorization": authorization }
    const request = requestHttp({
      host: "127.0.0.1",
      port: findProxyPort(proxy),
      method: "CONNECT",
      path: target,
      headers
    })
    request.once("connect", (response, socket) =>
      resolve(buildConnectOutcome(response, socket))
    )
    request.once("error", () => resolve({ status: "refused" }))
    request.end()
  })
}

/**
 * Reads one page through an open tunnel.
 *
 * @param socket - Tunnel to a local page server.
 * @returns Everything the server sent until it closed the tunnel.
 */
function readPageThroughTunnel(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.once("close", () => resolve(Buffer.concat(chunks).toString()))
    socket.write(
      "GET /moths HTTP/1.1\r\nHost: pages.test\r\nConnection: close\r\n\r\n"
    )
  })
}

/**
 * Sends one plain http request through a proxy.
 *
 * @param proxy - Proxy to send it to.
 * @param url - Absolute http URL to request.
 * @param authorization - Proxy-Authorization value, or undefined to send none.
 * @returns The answer, or `refused` when the proxy closed the connection.
 */
function sendForward(
  proxy: PageProxy,
  url: string,
  authorization: string | undefined
): Promise<ForwardOutcome> {
  return new Promise((resolve) => {
    const headers =
      authorization === undefined
        ? {}
        : { "proxy-authorization": authorization }
    const request = requestHttp(
      { host: "127.0.0.1", port: findProxyPort(proxy), path: url, headers },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.once("end", () =>
          resolve({
            status: "answered",
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString()
          })
        )
      }
    )
    request.once("error", () => resolve({ status: "refused" }))
    request.end()
  })
}

/**
 * Waits until a socket has closed.
 *
 * @param socket - Socket to watch.
 * @returns A promise that resolves once it has closed.
 */
function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve()
  return new Promise((resolve) => socket.once("close", () => resolve()))
}

/**
 * Tries to open a TCP connection.
 *
 * @param port - Local port to connect to.
 * @returns `connected` when a listener accepted it, or the error code.
 */
function tryConnecting(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.destroy()
      resolve("connected")
    })
    socket.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code ?? "failed")
    )
  })
}

describe("PageProxy", () => {
  it("tunnels a CONNECT to an allowed host and carries the page both ways", async () => {
    const server = await startPageServer(
      answerWithBody("text/plain", "Moths fly at night.")
    )
    const proxy = await openTestProxy()

    const outcome = await sendConnect(
      proxy,
      `pages.test:${server.port}`,
      formatProxyAuthorization(proxy.credentials)
    )
    if (outcome.status !== "connected") throw new Error("Expected a tunnel")
    const response = await readPageThroughTunnel(outcome.socket)

    expect(response).toMatch(/^HTTP\/1\.1 200 OK/)
    expect(response).toMatch(/Moths fly at night\.$/)
  })

  it("forwards a plain http request to an allowed host without its proxy credentials", async () => {
    const server = await startPageServer(
      answerWithBody("text/plain", "Moths fly at night.")
    )
    const proxy = await openTestProxy()

    const outcome = await sendForward(
      proxy,
      `http://pages.test:${server.port}/moths`,
      formatProxyAuthorization(proxy.credentials)
    )

    expect(outcome).toEqual({
      status: "answered",
      statusCode: 200,
      body: "Moths fly at night."
    })
    expect(server.receivedHeaders).toHaveLength(1)
    expect(server.receivedHeaders[0]?.["proxy-authorization"]).toBeUndefined()
    expect(server.receivedHeaders[0]?.host).toBe(`pages.test:${server.port}`)
  })

  it("asks for credentials and contacts nothing when a CONNECT has none", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "page"))
    const proxy = await openTestProxy()

    const outcome = await sendConnect(
      proxy,
      `pages.test:${server.port}`,
      undefined
    )

    expect(outcome).toMatchObject({
      status: "answered",
      statusCode: 407,
      headers: { "proxy-authenticate": 'Basic realm="Lys"' }
    })
    expect(server.receivedHeaders).toHaveLength(0)
  })

  it("asks for credentials when a forwarded request carries another proxy's", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "page"))
    const proxy = await openTestProxy()
    const otherProxy = await openTestProxy()

    const outcome = await sendForward(
      proxy,
      `http://pages.test:${server.port}/moths`,
      formatProxyAuthorization(otherProxy.credentials)
    )

    expect(outcome).toMatchObject({ status: "answered", statusCode: 407 })
    expect(server.receivedHeaders).toHaveLength(0)
  })

  it("rejects a CONNECT target that is not a host and a port", async () => {
    const proxy = await openTestProxy()

    const outcome = await sendConnect(
      proxy,
      "pages.test",
      formatProxyAuthorization(proxy.credentials)
    )

    expect(outcome).toMatchObject({ status: "answered", statusCode: 400 })
  })

  it("refuses a host whose address is blocked and records why", async () => {
    const proxy = await openTestProxy()

    const outcome = await sendConnect(
      proxy,
      "private.test:443",
      formatProxyAuthorization(proxy.credentials)
    )

    expect(outcome).toEqual({ status: "refused" })
    expect(proxy.findRefusal("private.test", 443)).toEqual({
      host: "private.test",
      port: 443,
      kind: "blocked-address"
    })
  })

  it("refuses a blocked IP address once its socket has connected", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "page"))
    const proxy = await openTestProxy({
      ...LOOPBACK_ONLY_DEPENDENCIES,
      isBlockedAddress: () => true
    })

    const outcome = await sendConnect(
      proxy,
      `127.0.0.1:${server.port}`,
      formatProxyAuthorization(proxy.credentials)
    )

    expect(outcome).toEqual({ status: "refused" })
    expect(proxy.findRefusal("127.0.0.1", server.port)?.kind).toBe(
      "blocked-address"
    )
    expect(server.receivedHeaders).toHaveLength(0)
  })

  it("refuses a host without an address and records why", async () => {
    const proxy = await openTestProxy()

    const outcome = await sendConnect(
      proxy,
      "missing.test:443",
      formatProxyAuthorization(proxy.credentials)
    )

    expect(outcome).toEqual({ status: "refused" })
    expect(proxy.findRefusal("missing.test", 443)?.kind).toBe(
      "unresolvable-host"
    )
  })

  it("refuses a forwarded request to a blocked host and records why", async () => {
    const proxy = await openTestProxy()

    const outcome = await sendForward(
      proxy,
      "http://private.test/moths",
      formatProxyAuthorization(proxy.credentials)
    )

    expect(outcome).toEqual({ status: "refused" })
    expect(proxy.findRefusal("private.test", 80)?.kind).toBe("blocked-address")
  })

  it("records no refusal for a host it has not refused", async () => {
    const proxy = await openTestProxy()

    expect(proxy.findRefusal("pages.test", 443)).toBeUndefined()
  })

  it("refuses connections past its connection limit", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "page"))
    const proxy = await openTestProxy({
      ...LOOPBACK_ONLY_DEPENDENCIES,
      limits: { ...GENEROUS_LIMITS, maximumConnections: 1 }
    })

    const first = await sendConnect(
      proxy,
      `pages.test:${server.port}`,
      formatProxyAuthorization(proxy.credentials)
    )
    const second = await sendConnect(
      proxy,
      `pages.test:${server.port}`,
      formatProxyAuthorization(proxy.credentials)
    )

    expect(first.status).toBe("connected")
    expect(second).toEqual({ status: "refused" })
    expect(
      proxy.findRefusal("pages.test", server.port),
      "a limit is not an address refusal"
    ).toBeUndefined()
  })

  it("closes every tunnel and refuses new ones once it has received more than its byte limit", async () => {
    const largeBody = "m".repeat(256 * 1024)
    const server = await startPageServer(
      answerWithBody("text/plain", largeBody)
    )
    const proxy = await openTestProxy({
      ...LOOPBACK_ONLY_DEPENDENCIES,
      limits: { ...GENEROUS_LIMITS, maximumReceivedBytes: 1024 }
    })

    const outcome = await sendConnect(
      proxy,
      `pages.test:${server.port}`,
      formatProxyAuthorization(proxy.credentials)
    )
    if (outcome.status !== "connected") throw new Error("Expected a tunnel")
    const response = await readPageThroughTunnel(outcome.socket)
    const later = await sendConnect(
      proxy,
      `pages.test:${server.port}`,
      formatProxyAuthorization(proxy.credentials)
    )

    expect(response.length).toBeLessThan(largeBody.length)
    expect(later).toEqual({ status: "refused" })
  })

  it("closes its open tunnels and its port when closed, and closing again resolves", async () => {
    const server = await startPageServer(answerWithBody("text/plain", "page"))
    const proxy = await PageProxy.open(LOOPBACK_ONLY_DEPENDENCIES)
    const port = findProxyPort(proxy)
    const outcome = await sendConnect(
      proxy,
      `pages.test:${server.port}`,
      formatProxyAuthorization(proxy.credentials)
    )
    if (outcome.status !== "connected") throw new Error("Expected a tunnel")

    await Promise.all([proxy.close(), proxy.close()])
    await waitForSocketClose(outcome.socket)

    expect(await tryConnecting(port)).toBe("ECONNREFUSED")
    await expect(proxy.close()).resolves.toBeUndefined()
  })

  it("gives each proxy its own credentials", async () => {
    const proxy = await openTestProxy()
    const otherProxy = await openTestProxy()

    expect(proxy.credentials).not.toEqual(otherProxy.credentials)
    expect(proxy.credentials.username).not.toBe("")
    expect(proxy.credentials.password).not.toBe("")
  })
})
