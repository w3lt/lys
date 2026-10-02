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
 * rejects with the signal's abort reason, and an already aborted signal
 * rejects without calling `respond`.
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
      return await waitForResponseOrAbort(
        Promise.resolve(respond(request)),
        signal
      )
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
 * Creates a streamed chat completion response in the endpoint's SSE format.
 *
 * @param chunks - Chunks sent in order before the terminal `[DONE]` marker.
 * @returns A 200 `text/event-stream` response.
 */
export function createChatCompletionStreamResponse(
  chunks: readonly ChatCompletionChunk[]
): Response {
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n"
  ].join("")
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
  const delta: ChatCompletionChunk.Choice.Delta =
    fixture.content === undefined ? {} : { content: fixture.content }
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
