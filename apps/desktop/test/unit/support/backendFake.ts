import { expect, onTestFinished, vi } from "vitest"
import { createControlledPromise, waitForMicrotasks } from "./settlement"

/** One HTTP request received by the in-process backend double. */
export type ObservedBackendRequest = Readonly<{
  /** Absolute request URL, including any query string. */
  url: string
  /** HTTP method. */
  method: string
  /** Request headers as sent. */
  headers: Headers
  /** JSON-decoded text body, or undefined when no body was sent. */
  body: unknown
  /** Requested cache mode, or undefined when the client left the default. */
  cache: RequestCache | undefined
  /** Cancellation signal the client attached, if any. */
  signal: AbortSignal | undefined
}>

/** Produces the backend response for one request the case expects. */
export type BackendRoute = (
  request: ObservedBackendRequest
) => Response | Promise<Response>

/**
 * Responses of the backend double, keyed by `"<METHOD> <path>"`.
 *
 * @remarks The path excludes the origin and the query string, so one route
 * answers every query of a list endpoint; a route reads the query from the
 * observed URL when it matters.
 */
export type BackendRoutes = Readonly<Record<string, BackendRoute>>

/** Observation handle of a started backend double. */
export type BackendFake = Readonly<{
  /** Requests in arrival order; grows as the client sends requests. */
  requests: readonly ObservedBackendRequest[]
}>

/** Status the double answers for a request no route expects. */
const UNEXPECTED_REQUEST_STATUS = 501

/** Transport failures made by {@link createTransportFailure}. */
const transportFailures = new WeakSet<TypeError>()

/**
 * Creates the rejection a route returns to fail its request the way the
 * platform `fetch` fails when the backend cannot be reached.
 *
 * @returns A `TypeError`, the type the platform `fetch` rejects with on a
 * network failure. Return it from a route as `Promise.reject(failure)`.
 * @remarks Only a rejection made here reaches the client as a transport
 * failure. Any other exception a route raises fails the case when it
 * finishes, so a broken route or fixture cannot pass as a handled
 * transport failure.
 */
export function createTransportFailure(): TypeError {
  const failure = new TypeError("fetch failed")
  transportFailures.add(failure)
  return failure
}

/**
 * Answers whether a route's rejection is a transport failure the case made on
 * purpose.
 *
 * @param failure - Value the route threw or rejected with.
 * @returns Whether {@link createTransportFailure} made it.
 */
function isTransportFailure(failure: unknown): boolean {
  return failure instanceof TypeError && transportFailures.has(failure)
}

/**
 * Runs the route of one request, recording an exception it raised other
 * than an intended transport failure.
 *
 * @param route - Route the request matched.
 * @param request - Observed request.
 * @param recordRouteFailure - Records the unintended exception.
 * @returns The route's response. Rejects with the route's own rejection, so
 * the client sees a failed `fetch` either way.
 */
async function answerBackendRoute(
  route: BackendRoute,
  request: ObservedBackendRequest,
  recordRouteFailure: (failure: unknown) => void
): Promise<Response> {
  try {
    return await route(request)
  } catch (failure) {
    if (!isTransportFailure(failure)) recordRouteFailure(failure)
    throw failure
  }
}

/**
 * Replaces the global `fetch` with an in-process backend that answers only
 * the routes a case declares.
 *
 * @param routes - Responses for the requests the case expects.
 * @returns A handle recording every received request.
 * @remarks Vitest removes the substitution after the case
 * (`unstubGlobals`). A request no route matches is answered with HTTP 501 and
 * fails the case when it finishes, so an unexpected request can never pass
 * as a handled transport failure. For the same reason, a route that throws
 * or rejects with anything but {@link createTransportFailure}'s failure fails
 * the case when it finishes. Like the platform `fetch`, a request whose
 * signal is already aborted rejects without reaching a route, a request whose
 * signal aborts before its route answers rejects with the abort reason, and a
 * signal that aborts later errors the response body and cancels the body the
 * route produced.
 */
export function startBackendFake(routes: BackendRoutes): BackendFake {
  const requests: ObservedBackendRequest[] = []
  const unexpectedRequests: string[] = []
  const routeFailures: string[] = []
  onTestFinished(() => {
    expect(unexpectedRequests, "requests no route expected").toEqual([])
    expect(routeFailures, "routes that failed instead of answering").toEqual([])
  })
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const signal = init.signal ?? undefined
      signal?.throwIfAborted()
      const request = buildObservedBackendRequest(input, init, signal)
      requests.push(request)
      const routeKey = `${request.method} ${new URL(request.url).pathname}`
      const route = routes[routeKey]
      if (route === undefined) {
        unexpectedRequests.push(routeKey)
        return new Response(null, { status: UNEXPECTED_REQUEST_STATUS })
      }
      const response = await waitForResponseOrAbort(
        answerBackendRoute(route, request, (failure) => {
          routeFailures.push(`${routeKey}: ${String(failure)}`)
        }),
        signal
      )
      return signal === undefined
        ? response
        : buildAbortableResponse(response, signal)
    }
  )
  return Object.freeze({ requests })
}

/**
 * Builds the frozen observation of one `fetch` call.
 *
 * @param input - Request target passed to `fetch`.
 * @param init - Request options passed to `fetch`.
 * @param signal - Cancellation signal taken from the options.
 * @returns The observed request with its JSON body decoded.
 * @throws A `SyntaxError` when a text body is not JSON; every backend request
 * the desktop sends carries JSON, so another body fails the case.
 */
function buildObservedBackendRequest(
  input: string | URL | Request,
  init: RequestInit,
  signal: AbortSignal | undefined
): ObservedBackendRequest {
  return Object.freeze({
    url: input instanceof Request ? input.url : String(input),
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    cache: init.cache,
    signal
  })
}

/**
 * Waits for a response unless the request signal aborts first.
 *
 * @param response - Pending route response.
 * @param signal - Request cancellation signal, if any.
 * @returns The response when it settles before cancellation.
 * @throws The signal's abort reason when cancellation wins.
 */
async function waitForResponseOrAbort(
  response: Promise<Response>,
  signal: AbortSignal | undefined
): Promise<Response> {
  if (signal === undefined) {
    return await response
  }
  const cancellation = createControlledPromise<never>()
  const rejectWithAbortReason = () => cancellation.reject(signal.reason)
  signal.addEventListener("abort", rejectWithAbortReason, { once: true })
  // The route may have aborted the request before the listener existed.
  if (signal.aborted) {
    rejectWithAbortReason()
  }
  try {
    return await Promise.race([response, cancellation.promise])
  } finally {
    signal.removeEventListener("abort", rejectWithAbortReason)
  }
}

/**
 * Builds a response whose body errors with a request signal's abort reason
 * once that signal aborts, as a platform `fetch` body does.
 *
 * @param response - Route response; the returned response owns its body.
 * @param signal - Cancellation of the request the response answers.
 * @returns The response, unchanged when it has no body.
 */
function buildAbortableResponse(
  response: Response,
  signal: AbortSignal
): Response {
  if (response.body === null) {
    return response
  }
  return new Response(
    response.body.pipeThrough(new TransformStream(), { signal }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }
  )
}

/**
 * Builds a JSON response as the backend sends it.
 *
 * @param status - HTTP status.
 * @param body - Value serialized as the response body.
 * @param contentType - Media type header; defaults to the backend's
 * `application/json; charset=utf-8`.
 * @returns A response with the serialized body.
 */
export function buildJsonResponse(
  status: number,
  body: unknown,
  contentType = "application/json; charset=utf-8"
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType }
  })
}

/** Server-sent event stream a case writes while the client reads it. */
export type BackendEventStream = Readonly<{
  /** HTTP 200 `text/event-stream` response carrying the stream. */
  response: Response
  /**
   * Sends one event whose data is the JSON encoding of a value.
   *
   * @param data - Event payload.
   */
  sendEvent: (data: unknown) => void
  /**
   * Sends raw stream text, such as a malformed event.
   *
   * @param text - Text written to the stream unchanged.
   */
  sendText: (text: string) => void
  /** Ends the stream as the backend does after its last event. */
  close: () => void
  /**
   * Reports whether the client cancelled the stream body.
   *
   * @returns Whether the reader released the stream before it ended.
   */
  isCancelled: () => boolean
}>

/**
 * Starts a server-sent event stream for one response.
 *
 * @returns The response and the controls a case uses to write it.
 * @remarks The stream stays open until the case closes it or the client
 * cancels it. Writes after either are dropped, as a server's writes to a
 * closed connection are. When the case finishes, a stream still open is
 * closed and its reader is given a turn to settle, so no read the case
 * started outlives it.
 */
export function startBackendEventStream(): BackendEventStream {
  const encoder = new TextEncoder()
  let isStreamCancelled = false
  let streamController!: ReadableStreamDefaultController<Uint8Array>
  // The stream calls `start` synchronously, so the controller exists before
  // the response is returned.
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      streamController = controller
    },
    cancel: () => {
      isStreamCancelled = true
    }
  })
  let isStreamClosed = false
  const sendText = (text: string) => {
    if (isStreamCancelled || isStreamClosed) return
    streamController.enqueue(encoder.encode(text))
  }
  const close = () => {
    if (isStreamCancelled || isStreamClosed) return
    isStreamClosed = true
    streamController.close()
  }
  onTestFinished(async () => {
    close()
    await waitForMicrotasks()
  })
  return Object.freeze({
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }),
    sendEvent: (data: unknown) => {
      sendText(`data: ${JSON.stringify(data)}\n\n`)
    },
    sendText,
    close,
    isCancelled: () => isStreamCancelled
  })
}
