import fastifySse from "@fastify/sse"
import type { ChatApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import type {
  ChatRouteReply,
  ChatRouteRequest
} from "../../../src/modules/chat/chat/share"
import { createTestFastify, type TestFastify } from "./fastifyTestApp"

/** Path of the chat-shaped SSE route installed by {@link addChatSseRoute}. */
const CHAT_SSE_TEST_ROUTE_PATH = "/test/chat-sse"

/** One server-sent event decoded from a captured response body. */
export type ReceivedSseEvent = Readonly<{
  /** SSE event name. */
  event: string
  /** JSON-decoded `data` field. */
  data: unknown
}>

/** Completed response of the chat-shaped SSE test route. */
export type ChatSseRouteResponse = Readonly<{
  /** HTTP status sent by the route. */
  statusCode: number
  /** Response content type. */
  contentType: string | undefined
  /** Events in transmission order. */
  events: readonly ReceivedSseEvent[]
}>

/**
 * Creates a test application with the SSE plugin used by the chat route.
 *
 * @returns The application and its captured logs.
 * @throws If the SSE plugin cannot be registered.
 * @remarks The plugin keeps its default serializer, which writes each event's
 * data as JSON.
 */
export async function createChatSseTestApp(): Promise<TestFastify> {
  const testFastify = createTestFastify()
  await testFastify.app.register(fastifySse)
  return testFastify
}

/**
 * Installs an SSE-only POST route whose handler receives a real chat request
 * and reply owned by the test application.
 *
 * @param app - Application with the SSE plugin registered.
 * @param handleRequest - Test action run with the live request and reply; the
 * connection closes when it settles.
 */
export function addChatSseRoute(
  app: FastifyInstance,
  handleRequest: (
    request: ChatRouteRequest,
    reply: ChatRouteReply
  ) => Promise<void>
): void {
  app.route<ChatApiRoute>({
    method: "POST",
    url: CHAT_SSE_TEST_ROUTE_PATH,
    sse: "only",
    handler: handleRequest
  })
}

/**
 * Requests the chat-shaped SSE route and decodes its complete event stream.
 *
 * @param app - Application on which {@link addChatSseRoute} installed the route.
 * @returns The response after the handler settled and the stream ended.
 */
export async function requestChatSseRoute(
  app: FastifyInstance
): Promise<ChatSseRouteResponse> {
  const response = await app.inject({
    method: "POST",
    url: CHAT_SSE_TEST_ROUTE_PATH,
    headers: { accept: "text/event-stream" }
  })
  return Object.freeze({
    statusCode: response.statusCode,
    contentType: response.headers["content-type"],
    events: parseSseEvents(response.body)
  })
}

/**
 * Decodes named JSON events from a text/event-stream body.
 *
 * @param body - Complete response body.
 * @returns Events in body order; comment-only blocks are skipped.
 * @throws If an event block has no name or its data is not JSON.
 */
export function parseSseEvents(body: string): ReceivedSseEvent[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0 && !block.startsWith(":"))
    .map((block) => {
      const fields = new Map(
        block.split("\n").map((line) => {
          const separatorIndex = line.indexOf(": ")
          return [line.slice(0, separatorIndex), line.slice(separatorIndex + 2)]
        })
      )
      const event = fields.get("event")
      const data = fields.get("data")
      if (event === undefined || data === undefined) {
        throw new Error(`Malformed SSE event block: ${block}`)
      }
      return Object.freeze({ event, data: JSON.parse(data) })
    })
}
