import fastifySse from "@fastify/sse"
import type { ChatApiRoute } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import * as z from "zod"
import type {
  ChatRouteReply,
  ChatRouteRequest
} from "../../../src/modules/chat/chat/share"
import { createTestFastify, type TestFastify } from "./fastifyTestApp"

/** Path of the chat-shaped SSE route installed by {@link addChatSseRoute}. */
const CHAT_SSE_TEST_ROUTE_PATH = "/test/chat-sse"

/** Event payload fields read to select an injected serialization failure. */
const typedEventSchema = z.looseObject({ type: z.string() })

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

/** Transport faults injected into the SSE plugin of a test application. */
export type ChatSseTestAppOptions = Readonly<{
  /**
   * Event `type` values whose serialization throws, making `reply.sse.send`
   * reject while the connection remains open.
   */
  failingEventTypes?: readonly string[]
}>

/**
 * Creates a test application with the SSE plugin used by the chat route.
 *
 * @param options - Event types whose transport write fails.
 * @returns The application and its captured logs.
 * @throws If the SSE plugin cannot be registered.
 * @remarks The serializer writes every other event as JSON, like the plugin
 * default. A failure is raised before any byte of that event is written.
 */
export async function createChatSseTestApp(
  options: ChatSseTestAppOptions = {}
): Promise<TestFastify> {
  const testFastify = createTestFastify()
  const failingEventTypes = new Set(options.failingEventTypes)
  await testFastify.app.register(fastifySse, {
    serializer: (data: unknown) => {
      const typedEvent = typedEventSchema.safeParse(data)
      if (typedEvent.success && failingEventTypes.has(typedEvent.data.type)) {
        throw new Error(
          `Injected SSE serialization failure for ${typedEvent.data.type}`
        )
      }
      return JSON.stringify(data)
    }
  })
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
