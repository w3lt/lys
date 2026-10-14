import { randomUUID, timingSafeEqual } from "node:crypto"
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse
} from "node:http"
import { connect, isIP, type AddressInfo, type Socket } from "node:net"
import type { Duplex } from "node:stream"
import {
  ConnectionAddressError,
  createCheckedLookup,
  watchConnectedAddress,
  type ConnectionAddressFailureKind,
  type ConnectionAddressRule
} from "./webConnection"

/** Most work one proxy accepts for the read it serves. */
export type PageProxyLimits = Readonly<{
  /** Most outbound connections, inclusive; a positive integer. */
  maximumConnections: number
  /** Most bytes received from remote servers, inclusive; a positive integer. */
  maximumReceivedBytes: number
}>

/** What one proxy needs from its environment. */
export type PageProxyDependencies = ConnectionAddressRule &
  Readonly<{
    /** Work the proxy accepts before it refuses every connection. */
    limits: PageProxyLimits
  }>

/** A connection the proxy refused because of where it would go. */
export type PageProxyRefusal = Readonly<{
  /** Host name or IP address the connection was for, lowercase, unbracketed. */
  host: string
  /** TCP port the connection was for. */
  port: number
  /** Why the address rule refused it. */
  kind: ConnectionAddressFailureKind
}>

/** Username and password a client must send to use one proxy. */
export type PageProxyCredentials = Readonly<{
  /** Random username of the proxy. */
  username: string
  /** Random password of the proxy. */
  password: string
}>

/** Host and port one proxied connection goes to. */
type ProxyTarget = Readonly<{
  /** Host name or IP address, lowercase, unbracketed. */
  host: string
  /** TCP port, from 1 to 65535. */
  port: number
}>

/** A plain http request the proxy forwards. */
type ForwardTarget = Readonly<{
  /** Host and port the request goes to. */
  target: ProxyTarget
  /** Path and query of the request. */
  path: string
  /** `Host` header the remote server receives: the URL's host and port. */
  authority: string
}>

/** How a client reaches one proxy and proves it may use it. */
type PageProxyEndpoint = Readonly<{
  /** `http://127.0.0.1:<port>` of the listening proxy. */
  url: string
  /** Credentials the client sends. */
  credentials: PageProxyCredentials
  /** Exact `Proxy-Authorization` value those credentials make. */
  authorization: string
}>

/** Lifecycle and accepted work of one proxy. */
type PageProxyState =
  | Readonly<{
      /** The proxy accepts connections. */
      status: "ready"
      /** Outbound connections accepted so far. */
      connectionCount: number
      /** Bytes received from remote servers so far. */
      receivedByteCount: number
    }>
  | Readonly<{
      /** A limit was reached: every connection was closed, new ones are refused. */
      status: "exhausted"
    }>
  | Readonly<{
      /** Closing; every connection is refused. */
      status: "closing"
      /** Settles once the proxy has closed. */
      closure: Promise<void>
    }>
  | Readonly<{
      /** Closed; nothing is listening. */
      status: "closed"
    }>

/** Value of `Proxy-Authenticate` that asks a client for its credentials. */
const PROXY_AUTHENTICATION_CHALLENGE = 'Basic realm="Lys"'

/** Answer to a CONNECT request without the proxy's credentials. */
const PROXY_AUTHENTICATION_REQUIRED_RESPONSE = `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${PROXY_AUTHENTICATION_CHALLENGE}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`

/** Answer to a CONNECT request whose target is not a host and a port. */
const BAD_CONNECT_RESPONSE =
  "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

/** Answer that opens a tunnel. */
const CONNECTION_ESTABLISHED_RESPONSE =
  "HTTP/1.1 200 Connection Established\r\n\r\n"

/** Port of an http URL that names none. */
const DEFAULT_HTTP_PORT = 80

/** Highest TCP port, inclusive. */
const MAXIMUM_TCP_PORT = 65_535

/** Lowest HTTP status a response can be relayed with, inclusive. */
const MINIMUM_HTTP_STATUS = 100

/** Highest HTTP status a response can be relayed with, inclusive. */
const MAXIMUM_HTTP_STATUS = 999

/** Finds the host and port of a CONNECT target, a host name or IP literal. */
const CONNECT_TARGET_PATTERN =
  /^(?:\[([0-9a-f:.]+)\]|([^\s:@/[\]]+)):(\d{1,5})$/i

/** Headers that describe one hop and are never passed on. */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
])

/** State of a proxy that reached a limit. */
const EXHAUSTED_STATE: PageProxyState = Object.freeze({ status: "exhausted" })

/** State of a closed proxy. */
const CLOSED_STATE: PageProxyState = Object.freeze({ status: "closed" })

/**
 * Builds the target of a CONNECT request.
 *
 * @param authority - Untrusted request target, `host:port`.
 * @returns The host, lowercase and unbracketed, and the port; or undefined
 * when the target is not a host and a port from 1 to 65535.
 */
function parseConnectTarget(
  authority: string | undefined
): ProxyTarget | undefined {
  const match = CONNECT_TARGET_PATTERN.exec(authority ?? "")
  const host = match?.[1] ?? match?.[2]
  const port = Number(match?.[3])
  if (host === undefined || port < 1 || port > MAXIMUM_TCP_PORT) {
    return undefined
  }
  return Object.freeze({ host: host.toLowerCase(), port })
}

/**
 * Builds the target of a plain http request sent to the proxy.
 *
 * @param requestUrl - Untrusted absolute-form request target.
 * @returns Where the request goes, its path, and the `Host` value its URL
 * names, or undefined when the target is not an absolute http URL.
 */
function parseForwardTarget(
  requestUrl: string | undefined
): ForwardTarget | undefined {
  const url = URL.parse(requestUrl ?? "")
  if (url?.protocol !== "http:") return undefined
  const port = url.port === "" ? DEFAULT_HTTP_PORT : Number(url.port)
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1")
  const target: ProxyTarget = Object.freeze({ host, port })
  return Object.freeze({
    target,
    path: `${url.pathname}${url.search}`,
    authority: url.host
  })
}

/**
 * Answers whether a request carries the proxy's credentials.
 *
 * @param headers - Untrusted request headers.
 * @param authorization - Exact `Proxy-Authorization` value the proxy accepts.
 * @returns True when the header holds exactly that value; compared in
 * constant time.
 */
function isProxyAuthorized(
  headers: IncomingHttpHeaders,
  authorization: string
): boolean {
  const received = Buffer.from(headers["proxy-authorization"] ?? "")
  const expected = Buffer.from(authorization)
  return (
    received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
  )
}

/**
 * Builds the headers of a request or response passed on to its next hop.
 *
 * @param headers - Headers received.
 * @returns A copy without the headers that describe one hop.
 */
function buildPassedOnHeaders(
  headers: IncomingHttpHeaders
): OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
    )
  )
}

/**
 * Builds the headers of a forwarded request.
 *
 * @param headers - Headers the client sent.
 * @param authority - Host and port of the request's absolute URL.
 * @returns The headers passed on, with `Host` replaced by the URL's host and
 * port, as a proxy must for an absolute-form request.
 */
function buildForwardHeaders(
  headers: IncomingHttpHeaders,
  authority: string
): OutgoingHttpHeaders {
  return { ...buildPassedOnHeaders(headers), host: authority }
}

/**
 * Builds the address of a listening proxy and the credentials it accepts.
 *
 * @param port - Port the proxy listens on at 127.0.0.1.
 * @param credentials - Random credentials of the proxy.
 * @returns The endpoint, frozen.
 */
function buildProxyEndpoint(
  port: number,
  credentials: PageProxyCredentials
): PageProxyEndpoint {
  const token = Buffer.from(
    `${credentials.username}:${credentials.password}`
  ).toString("base64")
  return Object.freeze({
    url: `http://127.0.0.1:${port}`,
    credentials,
    authorization: `Basic ${token}`
  })
}

/**
 * Starts relaying bytes both ways through an opened tunnel.
 *
 * @param upstream - Connection to the remote server, just connected.
 * @param client - Connection of the client that asked for the tunnel.
 * @param head - Bytes the client sent after its CONNECT request.
 * @remarks Does nothing when the address rule already destroyed `upstream`.
 */
function startTunnelRelay(
  upstream: Socket,
  client: Duplex,
  head: Buffer
): void {
  if (upstream.destroyed) return
  client.write(CONNECTION_ESTABLISHED_RESPONSE)
  if (head.byteLength > 0) upstream.write(head)
  upstream.pipe(client)
  client.pipe(upstream)
}

/**
 * Sends a remote server's response to the client that asked for it.
 *
 * @param upstreamResponse - Response of the remote server.
 * @param response - Response to the client.
 * @param updateReceivedByteCount - Counts each chunk received.
 * @remarks A status outside 100 to 999, which no response can be sent with,
 * closes both connections instead, as an unreadable response would.
 */
function sendUpstreamResponse(
  upstreamResponse: IncomingMessage,
  response: ServerResponse,
  updateReceivedByteCount: (byteCount: number) => void
): void {
  const statusCode = upstreamResponse.statusCode ?? 0
  if (statusCode < MINIMUM_HTTP_STATUS || statusCode > MAXIMUM_HTTP_STATUS) {
    upstreamResponse.socket.destroy()
    response.socket?.destroy()
    return
  }
  response.writeHead(statusCode, buildPassedOnHeaders(upstreamResponse.headers))
  upstreamResponse.on("data", (chunk: Buffer) =>
    updateReceivedByteCount(chunk.byteLength)
  )
  upstreamResponse.pipe(response)
}

/**
 * Closes every connection in a set.
 *
 * @param sockets - Connections to destroy; each leaves the set as it closes.
 */
function closeSockets(sockets: ReadonlySet<Duplex>): void {
  for (const socket of sockets) socket.destroy()
}

/**
 * Starts a server listening on a random port of 127.0.0.1.
 *
 * @param server - Server that is not listening yet.
 * @returns The port it listens on.
 * @throws The server's listening failure.
 */
function openLoopbackListener(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/**
 * Closes a proxy server and every connection it carries.
 *
 * @param server - Listening server.
 * @param sockets - Every client and upstream connection still open.
 * @returns A promise that settles once the server has stopped listening.
 * @throws The server's closing failure.
 */
function closeProxyServer(
  server: Server,
  sockets: ReadonlySet<Duplex>
): Promise<void> {
  closeSockets(sockets)
  server.closeAllConnections()
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}

/**
 * Owns one HTTP proxy server and its connections to let one browser read
 * reach the web only through the address rule, while keeping that read
 * within its connection and byte limits.
 *
 * @remarks Listens on a random port of 127.0.0.1 and serves only clients
 * that send its random credentials. It tunnels `CONNECT host:port` requests
 * and forwards absolute-form `http://` requests. Every outbound connection
 * resolves its host through the checked lookup, so a host with any blocked
 * address is refused; a blocked IP literal is refused without connecting;
 * and every connection is checked again on the address the socket reached,
 * which covers rebinding. A refusal closes the
 * client's connection and is kept for {@link PageProxy.findRefusal}. Once a
 * limit is passed, every connection is closed and new ones are refused.
 * Owns its server and every client and upstream socket. Lifecycle: ready
 * (or exhausted) → closing → closed. Concurrency model: single-owner; the
 * read that opens it owns it on the Node event loop, where every socket
 * callback changes its state synchronously.
 */
export default class PageProxy {
  /** Listening server; owned. */
  readonly #server: Server

  /** Lookup, address rule, and limits of every connection. */
  readonly #dependencies: PageProxyDependencies

  /** Address and credentials clients use. */
  readonly #endpoint: PageProxyEndpoint

  /** Every open client and upstream connection; owned. */
  readonly #sockets = new Set<Duplex>()

  /** Refused connections, by `host:port`. */
  readonly #refusals = new Map<string, PageProxyRefusal>()

  /** Lifecycle and accepted work. */
  #state: PageProxyState = Object.freeze({
    status: "ready",
    connectionCount: 0,
    receivedByteCount: 0
  })

  /**
   * Stores an already listening server.
   *
   * @param server - Listening server, owned from now on.
   * @param dependencies - Lookup, address rule, and limits, lent for the
   * proxy's lifetime.
   * @param endpoint - Address and credentials of the server.
   */
  private constructor(
    server: Server,
    dependencies: PageProxyDependencies,
    endpoint: PageProxyEndpoint
  ) {
    this.#server = server
    this.#dependencies = dependencies
    this.#endpoint = endpoint
  }

  /**
   * Opens a proxy for one read.
   *
   * @param dependencies - Lookup, address rule, and limits, lent for the
   * proxy's lifetime.
   * @returns A ready proxy listening on a random port of 127.0.0.1, with new
   * random credentials. The caller owns it and must close it.
   * @throws When the server cannot listen; nothing is left open.
   */
  public static async open(
    dependencies: PageProxyDependencies
  ): Promise<PageProxy> {
    const server = createServer()
    const port = await openLoopbackListener(server)
    const credentials: PageProxyCredentials = Object.freeze({
      username: randomUUID(),
      password: randomUUID()
    })
    const proxy = new PageProxy(
      server,
      dependencies,
      buildProxyEndpoint(port, credentials)
    )
    proxy.#registerServerHandlers()
    return proxy
  }

  /**
   * Proxy server a browser is given.
   *
   * @returns `http://127.0.0.1:<port>`.
   */
  public get url(): string {
    return this.#endpoint.url
  }

  /**
   * Credentials a client must send.
   *
   * @returns The random username and password made when the proxy opened.
   */
  public get credentials(): PageProxyCredentials {
    return this.#endpoint.credentials
  }

  /**
   * Finds why the proxy refused connections to one host and port.
   *
   * @param host - Host name or IP address, any case, with or without
   * brackets.
   * @param port - TCP port.
   * @returns The refusal, or undefined when the proxy refused none there by
   * the address rule. A connection refused by a limit is not recorded.
   */
  public findRefusal(host: string, port: number): PageProxyRefusal | undefined {
    const normalizedHost = host.replace(/^\[(.*)\]$/, "$1").toLowerCase()
    return this.#refusals.get(`${normalizedHost}:${port}`)
  }

  /**
   * Closes the proxy: every connection, then the server.
   *
   * @returns A promise that settles once the server stopped listening;
   * concurrent and repeated calls share it, and a call after closing
   * resolves at once. The proxy ends closed even when closing fails.
   * @throws The server's closing failure.
   */
  public close(): Promise<void> {
    switch (this.#state.status) {
      case "closing":
        return this.#state.closure
      case "closed":
        return Promise.resolve()
      case "ready":
      case "exhausted":
        break
    }
    const closure = closeProxyServer(this.#server, this.#sockets).finally(
      () => {
        this.#state = CLOSED_STATE
      }
    )
    this.#state = Object.freeze({ status: "closing", closure })
    return closure
  }

  /** Attaches the proxy's handlers to its server. */
  #registerServerHandlers(): void {
    this.#server.on("connection", (socket: Socket) => this.#addSocket(socket))
    this.#server.on(
      "connect",
      (request: IncomingMessage, socket: Duplex, head: Buffer) =>
        this.#handleConnectRequest(request, socket, head)
    )
    this.#server.on(
      "request",
      (request: IncomingMessage, response: ServerResponse) =>
        this.#handleProxyRequest(request, response)
    )
  }

  /**
   * Tracks an open connection until it closes.
   *
   * @param socket - Client or upstream connection, owned from now on.
   * @remarks A connection error ends that connection only.
   */
  #addSocket(socket: Duplex): void {
    this.#sockets.add(socket)
    socket.on("error", () => socket.destroy())
    socket.once("close", () => this.#sockets.delete(socket))
  }

  /**
   * Handles one CONNECT request.
   *
   * @param request - The CONNECT request.
   * @param client - Client connection, owned by the proxy.
   * @param head - Bytes the client sent after the request.
   */
  #handleConnectRequest(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer
  ): void {
    if (!isProxyAuthorized(request.headers, this.#endpoint.authorization)) {
      client.end(PROXY_AUTHENTICATION_REQUIRED_RESPONSE)
      return
    }
    const target = parseConnectTarget(request.url)
    if (target === undefined) {
      client.end(BAD_CONNECT_RESPONSE)
      return
    }
    if (this.#refuseBlockedIpAddress(target) || !this.#offerConnection()) {
      client.destroy()
      return
    }
    this.#openTunnel(target, client, head)
  }

  /**
   * Handles one plain request: forwards an absolute http request.
   *
   * @param request - Request the client sent to the proxy.
   * @param response - Response to the client.
   */
  #handleProxyRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): void {
    if (!isProxyAuthorized(request.headers, this.#endpoint.authorization)) {
      response.writeHead(407, {
        "proxy-authenticate": PROXY_AUTHENTICATION_CHALLENGE,
        connection: "close"
      })
      response.end()
      return
    }
    const forward = parseForwardTarget(request.url)
    if (forward === undefined) {
      response.writeHead(400, { connection: "close" })
      response.end()
      return
    }
    if (
      this.#refuseBlockedIpAddress(forward.target) ||
      !this.#offerConnection()
    ) {
      request.socket.destroy()
      return
    }
    this.#sendForwardRequest(forward, request, response)
  }

  /**
   * Opens a tunnel from a client to a checked remote address.
   *
   * @param target - Host and port to tunnel to.
   * @param client - Client connection that asked for the tunnel.
   * @param head - Bytes the client sent after its CONNECT request.
   */
  #openTunnel(target: ProxyTarget, client: Duplex, head: Buffer): void {
    const upstream = connect({
      host: target.host,
      port: target.port,
      lookup: createCheckedLookup(this.#dependencies)
    })
    this.#addSocket(upstream)
    watchConnectedAddress(upstream, this.#dependencies.isBlockedAddress)
    upstream.on("data", (chunk: Buffer) =>
      this.#updateReceivedByteCount(chunk.byteLength)
    )
    upstream.once("error", (error: Error) => {
      this.#addRefusal(target, error)
      client.destroy()
    })
    client.once("close", () => upstream.destroy())
    upstream.once("connect", () => startTunnelRelay(upstream, client, head))
  }

  /**
   * Sends a plain http request on to a checked remote address and relays
   * its response.
   *
   * @param forward - Where the request goes and its path.
   * @param request - Request the client sent.
   * @param response - Response to the client.
   */
  #sendForwardRequest(
    forward: ForwardTarget,
    request: IncomingMessage,
    response: ServerResponse
  ): void {
    const upstreamRequest = requestHttp(
      {
        host: forward.target.host,
        port: forward.target.port,
        method: request.method,
        path: forward.path,
        headers: buildForwardHeaders(request.headers, forward.authority),
        agent: false,
        lookup: createCheckedLookup(this.#dependencies)
      },
      (upstreamResponse) =>
        sendUpstreamResponse(upstreamResponse, response, (byteCount) =>
          this.#updateReceivedByteCount(byteCount)
        )
    )
    upstreamRequest.once("socket", (socket: Socket) => {
      this.#addSocket(socket)
      watchConnectedAddress(socket, this.#dependencies.isBlockedAddress)
    })
    upstreamRequest.once("error", (error: Error) => {
      this.#addRefusal(forward.target, error)
      request.socket.destroy()
    })
    request.pipe(upstreamRequest)
  }

  /**
   * Refuses a target that is an IP address the address rule blocks, before
   * any connection to it, since a socket skips the lookup for an IP address.
   *
   * @param target - Host and port a client asked for.
   * @returns True when the target was refused and its refusal recorded; false
   * when it is a host name, which the checked lookup judges, or an allowed
   * IP address.
   */
  #refuseBlockedIpAddress(target: ProxyTarget): boolean {
    if (isIP(target.host) === 0) return false
    if (!this.#dependencies.isBlockedAddress(target.host)) return false
    this.#addRefusal(target, new ConnectionAddressError("blocked-address"))
    return true
  }

  /**
   * Offers one more outbound connection to the connection limit.
   *
   * @returns True when the proxy accepts it; false when it is closing, has
   * reached a limit, or reaches the connection limit now, which closes every
   * connection.
   */
  #offerConnection(): boolean {
    const state = this.#state
    if (state.status !== "ready") return false
    if (state.connectionCount >= this.#dependencies.limits.maximumConnections) {
      this.#state = EXHAUSTED_STATE
      closeSockets(this.#sockets)
      return false
    }
    this.#state = Object.freeze({
      ...state,
      connectionCount: state.connectionCount + 1
    })
    return true
  }

  /**
   * Counts bytes received from a remote server.
   *
   * @param byteCount - Bytes of one received chunk.
   * @remarks Passing the byte limit closes every connection.
   */
  #updateReceivedByteCount(byteCount: number): void {
    const state = this.#state
    if (state.status !== "ready") return
    const receivedByteCount = state.receivedByteCount + byteCount
    if (receivedByteCount > this.#dependencies.limits.maximumReceivedBytes) {
      this.#state = EXHAUSTED_STATE
      closeSockets(this.#sockets)
      return
    }
    this.#state = Object.freeze({ ...state, receivedByteCount })
  }

  /**
   * Keeps why the address rule refused a connection.
   *
   * @param target - Host and port of the connection.
   * @param error - Failure of the connection; only a
   * {@link ConnectionAddressError} is a refusal.
   */
  #addRefusal(target: ProxyTarget, error: Error): void {
    if (!(error instanceof ConnectionAddressError)) return
    const refusal: PageProxyRefusal = Object.freeze({
      host: target.host,
      port: target.port,
      kind: error.kind
    })
    this.#refusals.set(`${target.host}:${target.port}`, refusal)
  }
}
