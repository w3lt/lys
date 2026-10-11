import type {
  ChatCompletion,
  ChatCompletionChunk
} from "openai/resources/index.mjs"
import { vi } from "vitest"

/** Model identity reported by fixture completions. */
const FIXTURE_COMPLETION_MODEL = "fixture-model"

/** One HTTP request received by the in-process OpenAI-compatible endpoint. */
export type ObservedOpenAiRequest = Readonly<{
  /** Absolute request URL built by the SDK. */
  url: string
  /** HTTP method. */
  method: string
  /** Request headers as sent. */
  headers: Headers
  /** JSON-decoded request body, or undefined when no text body was sent. */
  body: unknown
}>

/** Produces the endpoint response for one observed request. */
export type OpenAiEndpointResponder = (
  request: ObservedOpenAiRequest
) => Response | Promise<Response>

/** Observation handle of a started OpenAI-compatible endpoint fake. */
export type OpenAiEndpointFake = Readonly<{
  /** Requests in arrival order; grows as the SDK sends requests. */
  requests: readonly ObservedOpenAiRequest[]
}>

/** Terminal and delta values of one fixture stream chunk choice. */
export type ChatCompletionChunkFixture = Readonly<{
  /** Delta text; omitted or null for a chunk without content. */
  content?: string | null
  /** Upstream finish marker; defaults to null. */
  finishReason?: ChatCompletionChunk.Choice["finish_reason"]
  /** Choice index; defaults to 0, the only choice the backend consumes. */
  index?: number
  /** Tool-call fragments the chunk carries; omitted for a chunk without any. */
  toolCalls?: readonly ChatCompletionChunk.Choice.Delta.ToolCall[]
}>

/**
 * Replaces the global `fetch` with an in-process OpenAI-compatible endpoint.
 *
 * @param respond - Produces the response for each request.
 * @returns A handle recording every received request.
 * @remarks Start it before constructing the `ChatService` under test, because
 * the OpenAI SDK captures `fetch` when its client is created. Vitest removes
 * the substitution after the case (`unstubGlobals`). Like the platform
 * `fetch`, a request whose signal aborts before its response is produced
 * rejects with the signal's abort reason, an already aborted signal rejects
 * without calling `respond`, and a signal that aborts later errors the
 * response body with its reason and cancels the body `respond` produced.
 */
export function startOpenAiEndpointFake(
  respond: OpenAiEndpointResponder
): OpenAiEndpointFake {
  const requests: ObservedOpenAiRequest[] = []
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const signal = init.signal ?? undefined
      signal?.throwIfAborted()
      const request = Object.freeze({
        url: input instanceof Request ? input.url : String(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined
      })
      requests.push(request)
      const response = await waitForResponseOrAbort(
        Promise.resolve(respond(request)),
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
 * Waits for a response unless the request signal aborts first.
 *
 * @param response - Pending endpoint response.
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
  const cancellation = Promise.withResolvers<never>()
  const rejectWithAbortReason = () => cancellation.reject(signal.reason)
  signal.addEventListener("abort", rejectWithAbortReason, { once: true })
  // The responder may have aborted the request before the listener existed.
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
 * @param response - Endpoint response; the returned response owns its body.
 * @param signal - Cancellation of the request the response answers.
 * @returns The response, unchanged when it has no body.
 * @remarks An abort also cancels the original body, so a body that stays
 * open observes the release.
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
 * Builds one server-sent event carrying a chat completion chunk.
 *
 * @param chunk - Chunk sent as the event's JSON data.
 * @returns The event text, ending with its blank line.
 */
function buildChatCompletionChunkEvent(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Creates a streamed chat completion response in the endpoint's SSE format.
 *
 * @param chunks - Chunks sent in order before the terminal `[DONE]` marker.
 * @returns A 200 `text/event-stream` response.
 */
export function createChatCompletionStreamResponse(
  chunks: readonly ChatCompletionChunk[]
): Response {
  const body = [
    ...chunks.map(buildChatCompletionChunkEvent),
    "data: [DONE]\n\n"
  ].join("")
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })
}

/**
 * Creates a streamed chat completion response that sends some chunks and
 * then stays open, like a model still writing its reply.
 *
 * @param chunks - Chunks sent in order; no `[DONE]` marker follows them.
 * @param handleBodyCancel - Called once when the reader cancels the body,
 * which is how the SDK releases a request it stops reading.
 * @returns A 200 `text/event-stream` response whose body never closes.
 */
export function createOpenChatCompletionStreamResponse(
  chunks: readonly ChatCompletionChunk[],
  handleBodyCancel: () => void
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(buildChatCompletionChunkEvent(chunk)))
    },
    cancel: handleBodyCancel
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })
}

/**
 * Creates a streamed chat completion response that sends some chunks and
 * then fails, like a connection that drops while the model writes its reply.
 *
 * @param chunks - Chunks sent in order; no `[DONE]` marker follows them.
 * @param failure - Error the body fails with once the reader asks for more
 * than the chunks, as a platform `fetch` body does when its connection ends
 * early. Failing only then keeps the chunks readable, because a failed body
 * discards the chunks its reader has not read.
 * @returns A 200 `text/event-stream` response whose body fails after the
 * chunks.
 */
export function createFailedChatCompletionStreamResponse(
  chunks: readonly ChatCompletionChunk[],
  failure: Error
): Response {
  const encoder = new TextEncoder()
  const body = ReadableStream.from(
    (function* () {
      for (const chunk of chunks)
        yield encoder.encode(buildChatCompletionChunkEvent(chunk))
      throw failure
    })()
  )
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })
}

/**
 * Creates a non-streamed chat completion response.
 *
 * @param completion - Completion returned as the JSON body.
 * @returns A 200 JSON response.
 */
export function createChatCompletionResponse(
  completion: ChatCompletion
): Response {
  return Response.json(completion, { status: 200 })
}

/**
 * Creates an endpoint error response that the SDK does not retry.
 *
 * @param status - HTTP error status.
 * @param message - Error message in the OpenAI error envelope.
 * @returns A JSON error response marked `x-should-retry: false`.
 */
export function createOpenAiErrorResponse(
  status: number,
  message: string
): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error" } },
    { status, headers: { "x-should-retry": "false" } }
  )
}

/**
 * Creates one streamed chat completion chunk with a single choice.
 *
 * @param fixture - Delta content, finish marker, and choice index.
 * @returns A complete chunk as the SDK yields it.
 */
export function createChatCompletionChunk(
  fixture: ChatCompletionChunkFixture
): ChatCompletionChunk {
  const delta = buildChunkDelta(fixture)
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: FIXTURE_COMPLETION_MODEL,
    choices: [
      {
        index: fixture.index ?? 0,
        delta,
        finish_reason: fixture.finishReason ?? null
      }
    ]
  }
}

/**
 * Builds the delta of one fixture chunk.
 *
 * @param fixture - Delta content and tool-call fragments.
 * @returns A delta carrying exactly the fixture's content and fragments.
 */
function buildChunkDelta(
  fixture: ChatCompletionChunkFixture
): ChatCompletionChunk.Choice.Delta {
  if (fixture.toolCalls === undefined)
    return fixture.content === undefined ? {} : { content: fixture.content }
  const toolCalls = [...fixture.toolCalls]
  return fixture.content === undefined
    ? { tool_calls: toolCalls }
    : { content: fixture.content, tool_calls: toolCalls }
}

/**
 * Creates a non-streamed completion with one choice at index 0.
 *
 * @param content - Assistant message content, or null for a reply without text.
 * @param finishReason - Reason the model stopped; defaults to `stop`.
 * @returns A complete chat completion.
 */
export function createChatCompletion(
  content: string | null,
  finishReason: ChatCompletion.Choice["finish_reason"] = "stop"
): ChatCompletion {
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 0,
    model: FIXTURE_COMPLETION_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: { role: "assistant", content, refusal: null }
      }
    ]
  }
}
