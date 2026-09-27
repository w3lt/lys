import type { FastifyInstance } from "fastify"
import { validatorCompiler } from "fastify-type-provider-zod"
import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import { onTestFinished } from "vitest"
import ChatService from "../../src/di/services/chatService"
import SqliteConversationStore from "../../src/di/services/conversationService"
import {
  createChatSseTestApp,
  parseSseEvents,
  type ChatSseTestAppOptions,
  type ReceivedSseEvent
} from "./chatSseRoute"
import type { TestFastify } from "./fastifyTestApp"
import {
  createChatCompletion,
  createChatCompletionResponse,
  createChatCompletionStreamResponse,
  installOpenAiEndpointFake,
  type OpenAiEndpointFake,
  type OpenAiEndpointResponder
} from "./openAiEndpointFake"

/** Published path of the chat route. */
const CHAT_PATH = "/api/v1/chat"

/** Test application decorated with the services the chat route borrows. */
export type ChatRouteTestApp = TestFastify &
  Readonly<{
    /** In-memory store decorated as `app.conversationService`. */
    store: SqliteConversationStore
    /** Endpoint receiving the requests of `app.chatService`. */
    endpoint: OpenAiEndpointFake
  }>

/** Completed chat response. */
export type ChatRouteResponse = Readonly<{
  /** HTTP status. */
  statusCode: number
  /** Response content type. */
  contentType: string | undefined
  /** Raw response body. */
  body: string
  /** Decoded events of an SSE response; empty otherwise. */
  events: readonly ReceivedSseEvent[]
}>

/**
 * Creates an application with SSE, schema validation, an in-memory
 * conversation store, and a chat service backed by the endpoint fake.
 *
 * @param respond - Behavior of the OpenAI-compatible endpoint.
 * @param transport - SSE transport faults.
 * @returns The application, captured logs, store, and endpoint log.
 * @remarks The chat route is not registered; each case calls the registrar
 * under test. The store is disposed when the test finishes.
 */
export async function createChatRouteTestApp(
  respond: OpenAiEndpointResponder,
  transport: ChatSseTestAppOptions = {}
): Promise<ChatRouteTestApp> {
  const testFastify = await createChatSseTestApp(transport)
  const store = SqliteConversationStore.open(":memory:")
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  const endpoint = installOpenAiEndpointFake(respond)
  testFastify.app.setValidatorCompiler(validatorCompiler)
  testFastify.app.decorate("conversationService", store)
  testFastify.app.decorate(
    "chatService",
    new ChatService({
      openAiBaseUrl: "http://lmstudio.test/v1",
      titleGenerationPrompt: "Summarize the message as a short title.",
      generatedTitleMaxLength: 50
    })
  )
  return Object.freeze({ ...testFastify, store, endpoint })
}

/**
 * Creates an endpoint behavior that streams a chat reply and answers title
 * requests with one title.
 *
 * @param chatChunks - Chunks of every streamed chat completion.
 * @param title - Title returned by every non-streamed title request.
 * @returns The responder.
 */
export function respondWithChatAndTitle(
  chatChunks: readonly ChatCompletionChunk[],
  title: string
): OpenAiEndpointResponder {
  return (request) =>
    isStreamedRequest(request.body)
      ? createChatCompletionStreamResponse(chatChunks)
      : createChatCompletionResponse(
          createChatCompletion(JSON.stringify({ title }))
        )
}

/**
 * Determines whether an observed request body asked for a streamed reply.
 *
 * @param body - JSON-decoded request body.
 * @returns True for a chat completion stream request.
 */
export function isStreamedRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "stream" in body &&
    body.stream === true
  )
}

/**
 * Sends one chat request accepting an event stream.
 *
 * @param app - Application with the chat route registered.
 * @param payload - Raw request body.
 * @returns The completed response.
 */
export async function requestChat(
  app: FastifyInstance,
  payload: unknown
): Promise<ChatRouteResponse> {
  const response = await app.inject({
    method: "POST",
    url: CHAT_PATH,
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json"
    },
    payload: JSON.stringify(payload)
  })
  const contentType = response.headers["content-type"]
  return Object.freeze({
    statusCode: response.statusCode,
    contentType,
    body: response.body,
    events:
      contentType === "text/event-stream" ? parseSseEvents(response.body) : []
  })
}
