import {
  chatApi,
  chatApiStreamEventSchema,
  chatBackendToolUnavailableProblemSchema,
  chatContextApi,
  llmModelNotLoadedProblemSchema,
  llmRuntimeUnavailableProblemSchema,
  llmServiceBusyProblemSchema,
  chatReplyEventSchema,
  chatReplyEventsApi,
  chatToolCallNotPendingProblemSchema,
  conversationAgentMissingProblemSchema,
  sendChatToolApprovalApi,
  sendChatToolResultApi,
  stopChatReplyApi,
  type BackendToolUnavailableReason,
  type ChatApiRequestBody,
  type ChatBackendToolUnavailableProblem,
  type ChatContextApiRequestBody,
  type ChatContextApiResponse,
  type ChatApiStreamEvent,
  type ChatReplyEvent,
  type ChatReplyPathParams,
  type ChatToolApprovalAnswer,
  type ChatToolCallPathParams,
  type ChatToolResult
} from "@lys/protocol"
import { EventSourceParserStream } from "eventsource-parser/stream"

import { DELETED_CONVERSATION_AGENT_MESSAGE } from "@/lib/conversation-agent-messages"

/** What the person can do for each reason a backend tool cannot run. */
const BACKEND_TOOL_UNAVAILABLE_ADVICE = Object.freeze({
  "api-key-missing":
    "no Tavily API key is saved. Add one in Settings → Secrets",
  "api-key-invalid":
    "the Tavily API key in settings.json isn't valid. Fix or remove secrets.tavilyApiKey in that file",
  "settings-unreadable":
    "Lys couldn't read settings.json. Fix that file by hand",
  "page-reader-not-ready":
    "vmo, Lys's page reader, isn't ready. See Settings → Runtime"
} satisfies Readonly<Record<BackendToolUnavailableReason, string>>)

/**
 * Formats the message of a chat request refused for an unavailable tool.
 *
 * @param toolName - Tool that cannot run.
 * @param reason - Why.
 * @returns One sentence naming the tool, why, and what to do, including
 * switching the tool off.
 */
function formatBackendToolUnavailableMessage(
  toolName: string,
  reason: BackendToolUnavailableReason
): string {
  return `${toolName} is unavailable: ${BACKEND_TOOL_UNAVAILABLE_ADVICE[reason]}, or switch ${toolName} off.`
}

/**
 * Chat request refused because an offered backend tool cannot run now.
 *
 * @remarks Its type tells the chat view to read the tool list again; its
 * message, built from the backend's problem, tells the person what to do.
 * The subclass preserves the native `Error` contract.
 */
export class BackendToolUnavailableError extends Error {
  /**
   * Creates the error for one refused request.
   *
   * @param problem - Validated problem the backend sent.
   */
  public constructor(problem: ChatBackendToolUnavailableProblem) {
    super(formatBackendToolUnavailableMessage(problem.toolName, problem.reason))
  }
}

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

/** Transport scope sampled once for one context measurement. */
export type ChatContextConnection = {
  /** Application-owned backend origin without a trailing slash. */
  readonly backendUrl: string
  /** Abandons the measurement; the backend may still finish it. */
  readonly signal: AbortSignal
}

/** Outcome of asking the backend what the next message would take. */
export type ChatContextMeasurementResult =
  | {
      /** The backend measured the conversation with the loaded model. */
      readonly status: "measured"
      /** The window and the tokens of each measured part. */
      readonly measurement: ChatContextApiResponse
    }
  | {
      /** LM Studio has no loaded instance of the model; nothing was measured. */
      readonly status: "model-not-loaded"
    }

/** Shared not-loaded outcome; it carries no per-occurrence data. */
const MODEL_NOT_LOADED_RESULT: ChatContextMeasurementResult = Object.freeze({
  status: "model-not-loaded"
})

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

/** Outcome of sending one tool call's result or approval answer to the backend. */
export type SendChatToolCallAnswerResult =
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
const ACCEPTED_RESULT: SendChatToolCallAnswerResult = Object.freeze({
  status: "accepted"
})

/** Shared not-pending outcome; it carries no per-occurrence data. */
const NOT_PENDING_RESULT: SendChatToolCallAnswerResult = Object.freeze({
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
 * @throws If the request, stream read, JSON parse, or event validation fails;
 * with {@link DELETED_CONVERSATION_AGENT_MESSAGE} when the backend reports
 * that the continued conversation's agent no longer exists, and a
 * {@link BackendToolUnavailableError} when an offered backend tool cannot run
 * now; neither stored anything.
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

  if (response.status === 409) {
    throw buildChatConflictError(await readFailureBody(response))
  }
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
 * Asks the backend how much of the model's context window a conversation
 * takes before its next message.
 *
 * @param payload - Valid request naming the conversation, the model, and the
 * tools the next message would offer, as the chat request would.
 * @param connection - Backend origin and the signal that abandons the
 * measurement.
 * @returns `measured` with the validated measurement, or `model-not-loaded`
 * when LM Studio has no loaded instance of the model.
 * @throws The abort reason when the signal aborts; the backend's own sentence
 * when its model operations are busy or LM Studio cannot be reached; and a
 * caller-safe sentence when the backend cannot be reached, answers with any
 * other status, or sends a measurement that does not match the contract.
 */
export async function getChatContextMeasurement(
  payload: ChatContextApiRequestBody,
  connection: ChatContextConnection
): Promise<ChatContextMeasurementResult> {
  const response = await getChatContextResponse(payload, connection)
  if (response.status !== 200) return await handleChatContextFailure(response)
  try {
    const body: unknown = await response.json()
    return {
      status: "measured",
      measurement: chatContextApi.responses[200].parse(body)
    }
  } catch (cause) {
    if (connection.signal.aborted) throw connection.signal.reason
    throw new Error("The backend sent an invalid context measurement.", {
      cause
    })
  }
}

/**
 * Sends one context measurement request.
 *
 * @param payload - Valid measurement request.
 * @param connection - Backend origin and the abandoning signal.
 * @returns The response whose body remains owned by the caller.
 * @throws The abort reason when the signal aborts, or a caller-safe error
 * retaining the transport failure as its cause.
 */
async function getChatContextResponse(
  payload: ChatContextApiRequestBody,
  connection: ChatContextConnection
): Promise<Response> {
  try {
    return await fetch(`${connection.backendUrl}${chatContextApi.path}`, {
      method: chatContextApi.method,
      headers: JSON_REQUEST_HEADERS,
      body: JSON.stringify(payload),
      signal: connection.signal,
      cache: "no-store"
    })
  } catch (cause) {
    if (connection.signal.aborted) throw connection.signal.reason
    throw new Error("The backend could not be reached.", { cause })
  }
}

/**
 * Reads a measurement response that carries no measurement.
 *
 * @param response - Response with a status other than 200, whose body is
 * consumed here.
 * @returns `model-not-loaded` when the body is the declared not-loaded
 * problem.
 * @throws With the backend's sentence for its declared busy or unavailable
 * problem, and with `The context could not be measured (HTTP <status>).`
 * for any other response.
 */
async function handleChatContextFailure(
  response: Response
): Promise<ChatContextMeasurementResult> {
  const body = await readFailureBody(response)
  if (llmModelNotLoadedProblemSchema.safeParse(body).success) {
    return MODEL_NOT_LOADED_RESULT
  }
  const runtimeProblem = llmRuntimeUnavailableProblemSchema
    .or(llmServiceBusyProblemSchema)
    .safeParse(body)
  if (runtimeProblem.success) throw new Error(runtimeProblem.data.detail)
  throw new Error(
    `The context could not be measured (HTTP ${response.status}).`
  )
}

/**
 * Sends the result of one call a running reply sent the desktop to run.
 *
 * @param target - Call and the reply and conversation that hold it.
 * @param result - Validated result: the desktop tool's output, or why it
 * produced none, whose `content` the model reads.
 * @param connection - Backend origin. The request is deliberately not
 * cancellable, so a result the tool produced still reaches the backend.
 * @returns `accepted` after the backend took the result, or `not-pending`
 * when the call was already answered or its reply ended. Sending the same
 * result again is therefore safe: a repeat after a lost response returns
 * `not-pending`.
 * @throws A caller-safe error when the backend cannot be reached or answers
 * with an undeclared response.
 */
export async function sendChatToolResult(
  target: ChatToolCallPathParams,
  result: ChatToolResult,
  connection: Pick<ChatReplyConnection, "backendUrl">
): Promise<SendChatToolCallAnswerResult> {
  return sendChatToolCallAnswer(
    {
      url: `${connection.backendUrl}${buildChatToolCallPath(sendChatToolResultApi.path, target)}`,
      method: sendChatToolResultApi.method,
      body: result
    },
    "tool result"
  )
}

/**
 * Sends the person's answer to one approval prompt of a running reply.
 *
 * @param target - Call and the reply and conversation that hold it.
 * @param answer - Validated answer: `allowed`, after which the backend runs
 * its tool or sends the desktop's tool's call to run, or `rejected`, whose
 * `content` the model reads.
 * @param connection - Backend origin. The request is deliberately not
 * cancellable, so an answer the person gave still reaches the backend.
 * @returns `accepted` after the backend took the answer, or `not-pending`
 * when the prompt was already answered or its reply ended. Sending the same
 * answer again is therefore safe.
 * @throws A caller-safe error when the backend cannot be reached or answers
 * with an undeclared response.
 */
export async function sendChatToolApproval(
  target: ChatToolCallPathParams,
  answer: ChatToolApprovalAnswer,
  connection: Pick<ChatReplyConnection, "backendUrl">
): Promise<SendChatToolCallAnswerResult> {
  return sendChatToolCallAnswer(
    {
      url: `${connection.backendUrl}${buildChatToolCallPath(sendChatToolApprovalApi.path, target)}`,
      method: sendChatToolApprovalApi.method,
      body: answer
    },
    "approval"
  )
}

/** One answer to a tool call, addressed to its endpoint. */
type ChatToolCallAnswerRequest = {
  /** Absolute URL of the call's tool-result or tool-approval endpoint. */
  readonly url: string
  /** HTTP method of the endpoint. */
  readonly method: string
  /** Validated answer, serialized as JSON. */
  readonly body: ChatToolResult | ChatToolApprovalAnswer
}

/**
 * Sends one answer to a tool call and reads the endpoint's declared
 * outcome.
 *
 * @param request - Endpoint and validated answer.
 * @param answerLabel - Words naming the answer in error messages.
 * @returns `accepted` for 204, or `not-pending` for the declared conflict.
 * @throws A caller-safe error when the backend cannot be reached or answers
 * with an undeclared response.
 */
async function sendChatToolCallAnswer(
  request: ChatToolCallAnswerRequest,
  answerLabel: string
): Promise<SendChatToolCallAnswerResult> {
  const response = await getChatReplyActionResponse(request.url, {
    method: request.method,
    headers: JSON_REQUEST_HEADERS,
    body: JSON.stringify(request.body),
    cache: "no-store"
  })
  if (response.status === 204) return ACCEPTED_RESULT
  if (response.status === 409) {
    const body = await readFailureBody(response)
    if (chatToolCallNotPendingProblemSchema.safeParse(body).success) {
      return NOT_PENDING_RESULT
    }
  }
  throw new Error(
    `The backend did not accept the ${answerLabel} (HTTP ${response.status}).`
  )
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
 * Determines whether a decoded body declares that a continued conversation's
 * agent no longer exists.
 *
 * @param body - Untrusted body of a failed chat response.
 * @returns Whether it validates as the declared missing conversation agent
 * problem.
 */
function isConversationAgentMissingProblem(body: unknown): boolean {
  return conversationAgentMissingProblemSchema.safeParse(body).success
}

/**
 * Builds the error of a chat request the backend refused with 409.
 *
 * @param body - Untrusted problem body.
 * @returns A {@link BackendToolUnavailableError} for an unavailable tool, the
 * deleted-agent error for a missing conversation agent, or a generic error
 * for any other 409 body.
 */
function buildChatConflictError(body: unknown): Error {
  const toolProblem = chatBackendToolUnavailableProblemSchema.safeParse(body)
  if (toolProblem.success) {
    return new BackendToolUnavailableError(toolProblem.data)
  }
  if (isConversationAgentMissingProblem(body)) {
    return new Error(DELETED_CONVERSATION_AGENT_MESSAGE)
  }
  return new Error("Chat request failed: 409")
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
 * @param routeTemplate - Tool-result or tool-approval route with
 * `:conversationId`, `:assistantMessageId`, and `:callId`.
 * @param target - Validated identifiers substituted after encoding.
 * @returns The route with every identifier percent-encoded.
 */
function buildChatToolCallPath(
  routeTemplate: string,
  target: ChatToolCallPathParams
): string {
  return buildChatReplyPath(routeTemplate, target).replace(
    ":callId",
    encodeURIComponent(target.callId)
  )
}
