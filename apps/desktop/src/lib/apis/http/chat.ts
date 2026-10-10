import {
  chatApi,
  chatApiStreamEventSchema,
  chatReplyEventSchema,
  chatReplyEventsApi,
  chatToolCallAnswerMismatchProblemSchema,
  chatToolCallNotPendingProblemSchema,
  sendChatToolResultApi,
  stopChatReplyApi,
  type ChatApiRequestBody,
  type ChatApiStreamEvent,
  type ChatReplyEvent,
  type ChatReplyPathParams,
  type ChatToolAnswer,
  type ChatToolResultPathParams
} from "@lys/protocol"
import { EventSourceParserStream } from "eventsource-parser/stream"

/** Transport options for reading one backend chat event stream. */
export type ChatApiOptions = {
  /**
   * Ends local observation of the stream.
   *
   * @remarks Aborting closes only this client's stream; the backend keeps
   * generating the reply. {@link stopChatReply} stops it.
   */
  readonly signal?: AbortSignal
}

/** Transport scope sampled once for one reply request. */
export type ChatReplyConnection = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
  /** Ends local observation of the stream; the reply keeps generating. */
  readonly signal?: AbortSignal
}

/** Outcome of asking the backend to stop one reply. */
export type StopChatReplyResult =
  | {
      /** The generation stopped and the reply's final state is stored. */
      readonly status: "stopped"
    }
  | {
      /** No generation was running for the reply; nothing changed. */
      readonly status: "not-generating"
    }

/** Headers for a JSON request that expects an event stream. */
const JSON_EVENT_STREAM_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    "Content-Type": "application/json",
    Accept: "text/event-stream"
  })

/** Headers for a bodyless request that expects an event stream. */
const EVENT_STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: "text/event-stream"
})

/** Headers for a bodyless request that expects JSON or no content. */
const ACCEPT_JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: "application/json"
})

/** Headers for a JSON request that expects JSON or no content. */
const JSON_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json",
  Accept: "application/json"
})

/** Shared stopped outcome; it carries no per-occurrence data. */
const STOPPED_RESULT: StopChatReplyResult = Object.freeze({ status: "stopped" })

/** Shared not-generating outcome; it carries no per-occurrence data. */
const NOT_GENERATING_RESULT: StopChatReplyResult = Object.freeze({
  status: "not-generating"
})

/** Outcome of sending one tool call's answer to the backend. */
export type SendChatToolResultResult =
  | {
      /** The backend accepted the answer; the reply's loop continues. */
      readonly status: "accepted"
    }
  | {
      /**
       * The call was not waiting for an answer: it was already answered, or
       * its reply ended. Nothing changed.
       */
      readonly status: "not-pending"
    }

/** Shared accepted outcome; it carries no per-occurrence data. */
const ACCEPTED_RESULT: SendChatToolResultResult = Object.freeze({
  status: "accepted"
})

/** Shared not-pending outcome; it carries no per-occurrence data. */
const NOT_PENDING_RESULT: SendChatToolResultResult = Object.freeze({
  status: "not-pending"
})

/** Caller-safe message for a followed reply the backend no longer stores. */
const MISSING_REPLY_MESSAGE = "The reply is no longer stored."

/**
 * Opens and reads one validated backend chat event stream.
 *
 * @remarks Ending iteration before the backend closes the stream cancels the
 * underlying reader before releasing it. The adapter targets the fixed local
 * backend loopback address and port used by the current desktop protocol; an
 * aborted signal propagates through `fetch` and reader cleanup and ends only
 * this observation, not the backend's generation.
 * @param payload - Valid chat prompt and the conversation it starts or
 * continues.
 * @param options - Optional transport cancellation settings.
 * @returns An async generator yielding validated chat protocol events.
 * @throws If the request, stream read, JSON parse, or event validation fails.
 */
export async function* readChatEvents(
  payload: ChatApiRequestBody,
  options?: ChatApiOptions
): AsyncGenerator<ChatApiStreamEvent, void, unknown> {
  const { signal } = options ?? {}
  const response = await fetch(`http://127.0.0.1:12345${chatApi.path}`, {
    method: chatApi.method,
    headers: JSON_EVENT_STREAM_HEADERS,
    body: JSON.stringify(payload),
    signal
  })

  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed: ${response.status}`)
  }

  yield* readServerSentEvents(response.body, (value) =>
    chatApiStreamEventSchema.parse(value)
  )
}

/**
 * Follows one stored reply: its snapshot, then its live events while it runs.
 *
 * @param target - Reply and the conversation that holds it.
 * @param connection - Backend origin and optional observation signal.
 * @returns An async generator yielding validated reply events; it completes
 * when the backend ends the stream.
 * @throws If the request fails, the backend reports the conversation or reply
 * as not stored, or reading, JSON parsing, or validation fails.
 * @remarks Ending iteration or aborting the signal stops only this
 * observation.
 */
export async function* readChatReplyEvents(
  target: ChatReplyPathParams,
  connection: ChatReplyConnection
): AsyncGenerator<ChatReplyEvent, void, unknown> {
  const response = await fetch(
    `${connection.backendUrl}${buildChatReplyPath(chatReplyEventsApi.path, target)}`,
    {
      method: chatReplyEventsApi.method,
      headers: EVENT_STREAM_HEADERS,
      signal: connection.signal,
      cache: "no-store"
    }
  )

  if (
    response.status === 404 &&
    isChatReplyAbsenceProblem(await readFailureBody(response))
  ) {
    throw new Error(MISSING_REPLY_MESSAGE)
  }
  if (!response.ok || !response.body) {
    throw new Error(`Chat reply request failed: ${response.status}`)
  }

  yield* readServerSentEvents(response.body, (value) =>
    chatReplyEventSchema.parse(value)
  )
}

/**
 * Asks the backend to stop one reply's running generation.
 *
 * @param target - Reply and the conversation that holds it.
 * @param connection - Backend origin. The request is deliberately not
 * cancellable, so a stop the user asked for still reaches the backend.
 * @returns `stopped` after the backend stored the reply's final state, or
 * `not-generating` when no generation was running for it.
 * @throws A caller-safe error when the backend cannot be reached or answers
 * with an undeclared response.
 */
export async function stopChatReply(
  target: ChatReplyPathParams,
  connection: Pick<ChatReplyConnection, "backendUrl">
): Promise<StopChatReplyResult> {
  const response = await getChatReplyActionResponse(
    `${connection.backendUrl}${buildChatReplyPath(stopChatReplyApi.path, target)}`,
    {
      method: stopChatReplyApi.method,
      headers: ACCEPT_JSON_HEADERS,
      cache: "no-store"
    }
  )
  if (response.status === 204) return STOPPED_RESULT
  if (
    response.status === 409 &&
    isReplyNotGeneratingProblem(await readFailureBody(response))
  ) {
    return NOT_GENERATING_RESULT
  }
  throw new Error(
    `The backend could not stop the reply (HTTP ${response.status}).`
  )
}

/**
 * Sends the answer to one tool call of a running reply.
 *
 * @param target - Call and the reply and conversation that hold it.
 * @param toolAnswer - Validated answer: a desktop tool's result or a
 * declined call, whose `content` the model reads, or `allowed`, which lets
 * the backend run its tool.
 * @param connection - Backend origin. The request is deliberately not
 * cancellable, so an answer the person gave still reaches the backend.
 * @returns `accepted` after the backend took the answer, or `not-pending`
 * when the call was already answered or its reply ended. Sending the same
 * answer again is therefore safe: a repeat after a lost response returns
 * `not-pending`.
 * @throws A caller-safe error when the backend cannot be reached, says the
 * answer does not fit the call, or answers with an undeclared response.
 */
export async function sendChatToolResult(
  target: ChatToolResultPathParams,
  toolAnswer: ChatToolAnswer,
  connection: Pick<ChatReplyConnection, "backendUrl">
): Promise<SendChatToolResultResult> {
  const response = await getChatReplyActionResponse(
    `${connection.backendUrl}${buildChatToolResultPath(target)}`,
    {
      method: sendChatToolResultApi.method,
      headers: JSON_REQUEST_HEADERS,
      body: JSON.stringify(toolAnswer),
      cache: "no-store"
    }
  )
  if (response.status === 204) return ACCEPTED_RESULT
  if (response.status !== 409) {
    throw new Error(
      `The backend did not accept the tool result (HTTP ${response.status}).`
    )
  }
  const body = await readFailureBody(response)
  if (chatToolCallNotPendingProblemSchema.safeParse(body).success) {
    return NOT_PENDING_RESULT
  }
  if (chatToolCallAnswerMismatchProblemSchema.safeParse(body).success) {
    throw new Error("The backend said this answer does not fit the tool call.")
  }
  throw new Error("The backend did not accept the tool result (HTTP 409).")
}

/**
 * Gets the response to one reply action request, such as a stop or a tool
 * result, in any HTTP status.
 *
 * @param url - Absolute URL of the reply action.
 * @param init - Method, headers, and body of the request; it carries no
 * abort signal, so the request reaches the backend once sent.
 * @returns The response whose body remains owned by the caller.
 * @throws A caller-safe error retaining the transport failure as its cause.
 */
async function getChatReplyActionResponse(
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (cause) {
    throw new Error("The backend could not be reached.", { cause })
  }
}

/**
 * Reads validated events from one SSE response body.
 *
 * @typeParam TStreamEvent - Validated event union of the endpoint.
 * @param body - Response body; this reader owns it from now on.
 * @param parseEvent - Authoritative schema parser for one event payload.
 * @returns An async generator yielding events until the backend closes the
 * stream.
 * @throws If reading, JSON parsing, or event validation fails.
 * @remarks Ending iteration before the backend closes the stream cancels the
 * body before releasing it.
 */
async function* readServerSentEvents<TStreamEvent>(
  body: NonNullable<Response["body"]>,
  parseEvent: (value: unknown) => TStreamEvent
): AsyncGenerator<TStreamEvent, void, unknown> {
  const source = body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new EventSourceParserStream({
      onError: "terminate"
    })
  )
  const reader = source.getReader()
  let hasReachedStreamEnd = false

  try {
    while (true) {
      const readResult = await reader.read()
      if (readResult.done) {
        hasReachedStreamEnd = true
        return
      }

      yield parseEvent(JSON.parse(readResult.value.data))
    }
  } finally {
    try {
      if (!hasReachedStreamEnd) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

/**
 * Determines whether a decoded body declares the followed reply or its
 * conversation absent.
 *
 * @param body - Untrusted body of a failed reply-events response.
 * @returns Whether it validates as a declared absence problem; a different
 * body, such as the one an unregistered route returns, does not.
 */
function isChatReplyAbsenceProblem(body: unknown): boolean {
  return chatReplyEventsApi.responses[404].safeParse(body).success
}

/**
 * Determines whether a decoded body declares that no generation runs for the
 * reply.
 *
 * @param body - Untrusted body of a failed stop response.
 * @returns Whether it validates as the declared not-generating problem.
 */
function isReplyNotGeneratingProblem(body: unknown): boolean {
  return stopChatReplyApi.responses[409].safeParse(body).success
}

/**
 * Reads a failed response's body as untrusted JSON.
 *
 * @param response - Failed response whose body is consumed here.
 * @returns The decoded body, or undefined when it is not readable JSON.
 */
async function readFailureBody(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json()
    return body
  } catch {
    return undefined
  }
}

/**
 * Builds the path addressing one reply from a shared route template.
 *
 * @param routeTemplate - Descriptor path containing `:conversationId` and
 * `:assistantMessageId`.
 * @param target - Validated identifiers substituted after encoding.
 * @returns The route with both identifiers percent-encoded.
 */
function buildChatReplyPath(
  routeTemplate: string,
  target: ChatReplyPathParams
): string {
  return routeTemplate
    .replace(":conversationId", encodeURIComponent(target.conversationId))
    .replace(
      ":assistantMessageId",
      encodeURIComponent(target.assistantMessageId)
    )
}

/**
 * Builds the path addressing one tool call of a reply.
 *
 * @param target - Validated identifiers substituted after encoding.
 * @returns The tool-result route with every identifier percent-encoded.
 */
function buildChatToolResultPath(target: ChatToolResultPathParams): string {
  return buildChatReplyPath(sendChatToolResultApi.path, target).replace(
    ":callId",
    encodeURIComponent(target.callId)
  )
}
