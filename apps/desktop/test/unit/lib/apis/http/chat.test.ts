import type { ChatApiRequestBody } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  readChatEvents,
  readChatReplyEvents,
  stopChatReply
} from "@/lib/apis/http/chat"
import {
  buildJsonResponse,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream
} from "../../../support/backendFake"
import {
  buildStreamingAssistantMessage,
  buildConversationMetadata,
  buildConversationNotFoundProblem,
  buildReplyNotFoundProblem,
  buildReplyNotGeneratingProblem,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../../support/conversationFixtures"

/** Backend origin the reply cases pass; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/** Reply the reply cases follow or stop. */
const REPLY_TARGET = Object.freeze({
  conversationId: FIXTURE_CONVERSATION_ID,
  assistantMessageId: createFixtureUuidV7(3)
})

/** Route key of the reply-events endpoint for {@link REPLY_TARGET}. */
const REPLY_EVENTS_ROUTE = `GET /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/events`

/** Route key of the reply-stop endpoint for {@link REPLY_TARGET}. */
const REPLY_STOP_ROUTE = `POST /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/stop`

/** Request that starts a new conversation. */
const NEW_CONVERSATION_REQUEST = Object.freeze<ChatApiRequestBody>({
  conversation: { kind: "new", agentCode: "lys" },
  message: "Hello",
  model: "qwen3-8b",
  generationOptions: { temperature: 0.7 }
})

/** Start event the backend sends for {@link NEW_CONVERSATION_REQUEST}. */
const NEW_CONVERSATION_START_EVENT = Object.freeze({
  type: "start-new-conversation-turn",
  conversation: buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
  userMessage: buildUserMessage(2, "Hello"),
  assistantMessage: buildStreamingAssistantMessage(3, "")
})

/**
 * Reads every event a stream yields until it completes or fails.
 *
 * @param events - Event stream under test.
 * @returns The events in arrival order.
 */
async function listStreamEvents<TEvent>(
  events: AsyncIterable<TEvent>
): Promise<TEvent[]> {
  const received: TEvent[] = []
  for await (const event of events) received.push(event)
  return received
}

/**
 * Reads one event and then stops reading, as a consumer that leaves early.
 *
 * @param events - Event stream under test.
 * @returns The first event, after the stream was ended from the reader side.
 */
async function readFirstStreamEvent<TEvent>(
  events: AsyncGenerator<TEvent, void, unknown>
): Promise<TEvent | void> {
  const first = await events.next()
  await events.return()
  return first.value
}

/**
 * Sends events and ends the stream.
 *
 * @param stream - Stream the backend writes.
 * @param events - Event payloads in sending order.
 */
function sendStreamEvents(
  stream: BackendEventStream,
  events: readonly unknown[]
): void {
  events.forEach((event) => stream.sendEvent(event))
  stream.close()
}

describe("readChatEvents", () => {
  it("posts the request to the local backend's chat endpoint", async () => {
    const stream = startBackendEventStream()
    const backend = startBackendFake({
      "POST /api/v1/chat": () => stream.response
    })
    const signal = new AbortController().signal
    stream.close()

    await listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST, { signal }))

    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]?.url).toBe("http://127.0.0.1:12345/api/v1/chat")
    expect(backend.requests[0]?.body).toEqual(NEW_CONVERSATION_REQUEST)
    expect(backend.requests[0]?.headers.get("Content-Type")).toBe(
      "application/json"
    )
    expect(backend.requests[0]?.headers.get("Accept")).toBe("text/event-stream")
    expect(backend.requests[0]?.signal).toBe(signal)
  })

  it("yields each event in order until the backend ends the stream", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ "POST /api/v1/chat": () => stream.response })
    const events = [
      NEW_CONVERSATION_START_EVENT,
      { type: "delta", content: "Hi" },
      { type: "title", title: "Greeting" },
      { type: "done", finishReason: "stop" }
    ]
    sendStreamEvents(stream, events)

    await expect(
      listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).resolves.toEqual(events)
  })

  it("rejects a failed request before yielding events", async () => {
    startBackendFake({
      "POST /api/v1/chat": () => buildJsonResponse(500, { detail: "boom" })
    })

    await expect(
      listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).rejects.toThrow("500")
  })

  it("rejects an event that breaks the stream contract", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ "POST /api/v1/chat": () => stream.response })
    sendStreamEvents(stream, [{ type: "delta", content: "" }])

    await expect(
      listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).rejects.toMatchObject({ name: "ZodError" })
  })

  it("rejects an event whose data is not JSON", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ "POST /api/v1/chat": () => stream.response })
    stream.sendText("data: {not json\n\n")
    stream.close()

    await expect(
      listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).rejects.toThrow(SyntaxError)
  })

  it("cancels the response body when the consumer stops reading early", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ "POST /api/v1/chat": () => stream.response })
    stream.sendEvent(NEW_CONVERSATION_START_EVENT)

    await expect(
      readFirstStreamEvent(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).resolves.toEqual(NEW_CONVERSATION_START_EVENT)
    expect(stream.isCancelled()).toBe(true)
  })

  it("ends observation with the abort reason when the signal aborts mid-stream", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ "POST /api/v1/chat": () => stream.response })
    const controller = new AbortController()
    stream.sendEvent(NEW_CONVERSATION_START_EVENT)
    const events = readChatEvents(NEW_CONVERSATION_REQUEST, {
      signal: controller.signal
    })
    await events.next()

    controller.abort()

    await expect(events.next()).rejects.toMatchObject({ name: "AbortError" })
    expect(stream.isCancelled()).toBe(true)
  })
})

describe("readChatReplyEvents", () => {
  it("follows the reply at the caller's backend origin", async () => {
    const stream = startBackendEventStream()
    const backend = startBackendFake({
      [REPLY_EVENTS_ROUTE]: () => stream.response
    })
    const signal = new AbortController().signal
    stream.close()

    await listStreamEvents(
      readChatReplyEvents(REPLY_TARGET, { backendUrl: BACKEND_URL, signal })
    )

    expect(backend.requests[0]?.url).toBe(
      `${BACKEND_URL}/api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/events`
    )
    expect(backend.requests[0]?.headers.get("Accept")).toBe("text/event-stream")
    expect(backend.requests[0]?.cache).toBe("no-store")
    expect(backend.requests[0]?.signal).toBe(signal)
  })

  it("yields the snapshot and the live events in order", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [REPLY_EVENTS_ROUTE]: () => stream.response })
    const events = [
      {
        type: "reply-snapshot",
        conversationTitle: null,
        assistantMessage: buildStreamingAssistantMessage(3, "Hi")
      },
      { type: "delta", content: " there" },
      { type: "done", finishReason: "length" }
    ]
    sendStreamEvents(stream, events)

    await expect(
      listStreamEvents(
        readChatReplyEvents(REPLY_TARGET, { backendUrl: BACKEND_URL })
      )
    ).resolves.toEqual(events)
  })

  it.each([
    ["conversation", buildConversationNotFoundProblem()],
    ["reply", buildReplyNotFoundProblem()]
  ])(
    "reports a %s the backend declares absent as no longer stored",
    async (_absent, problem) => {
      startBackendFake({
        [REPLY_EVENTS_ROUTE]: () => buildJsonResponse(404, problem)
      })

      await expect(
        listStreamEvents(
          readChatReplyEvents(REPLY_TARGET, { backendUrl: BACKEND_URL })
        )
      ).rejects.toThrow("no longer stored")
    }
  )

  it("does not report an undeclared 404 as an absent reply", async () => {
    startBackendFake({
      [REPLY_EVENTS_ROUTE]: () =>
        buildJsonResponse(404, { message: "Route not found" })
    })

    const events = listStreamEvents(
      readChatReplyEvents(REPLY_TARGET, { backendUrl: BACKEND_URL })
    )

    await expect(events).rejects.toThrow("404")
    await expect(events).rejects.not.toThrow("no longer stored")
  })

  it("rejects an event that breaks the reply-event contract", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [REPLY_EVENTS_ROUTE]: () => stream.response })
    sendStreamEvents(stream, [{ type: "start-new-conversation-turn" }])

    await expect(
      listStreamEvents(
        readChatReplyEvents(REPLY_TARGET, { backendUrl: BACKEND_URL })
      )
    ).rejects.toMatchObject({ name: "ZodError" })
  })

  it("cancels the response body when the consumer stops reading early", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [REPLY_EVENTS_ROUTE]: () => stream.response })
    stream.sendEvent({ type: "delta", content: "Hi" })

    await readFirstStreamEvent(
      readChatReplyEvents(REPLY_TARGET, { backendUrl: BACKEND_URL })
    )

    expect(stream.isCancelled()).toBe(true)
  })
})

describe("stopChatReply", () => {
  it("reports stopped for the backend's acknowledgement, without a cancellation signal", async () => {
    const backend = startBackendFake({
      [REPLY_STOP_ROUTE]: () => new Response(null, { status: 204 })
    })

    await expect(
      stopChatReply(REPLY_TARGET, { backendUrl: BACKEND_URL })
    ).resolves.toEqual({ status: "stopped" })
    expect(backend.requests[0]?.url).toBe(
      `${BACKEND_URL}/api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/stop`
    )
    expect(backend.requests[0]?.signal).toBeUndefined()
  })

  it("reports not generating for the declared conflict", async () => {
    startBackendFake({
      [REPLY_STOP_ROUTE]: () =>
        buildJsonResponse(409, buildReplyNotGeneratingProblem())
    })

    await expect(
      stopChatReply(REPLY_TARGET, { backendUrl: BACKEND_URL })
    ).resolves.toEqual({ status: "not-generating" })
  })

  it.each([
    ["an undeclared success", 200, { status: "stopped" }],
    ["an undeclared conflict", 409, { message: "conflict" }],
    ["a missing reply", 404, buildReplyNotFoundProblem()],
    ["a server failure", 500, { detail: "boom" }]
  ])("rejects %s with its status", async (_label, status, body) => {
    startBackendFake({
      [REPLY_STOP_ROUTE]: () => buildJsonResponse(status, body)
    })

    await expect(
      stopChatReply(REPLY_TARGET, { backendUrl: BACKEND_URL })
    ).rejects.toThrow(String(status))
  })

  it("rejects when the backend cannot be reached and keeps the transport failure as its cause", async () => {
    const transportFailure = new TypeError("fetch failed")
    startBackendFake({
      [REPLY_STOP_ROUTE]: () => Promise.reject(transportFailure)
    })

    await expect(
      stopChatReply(REPLY_TARGET, { backendUrl: BACKEND_URL })
    ).rejects.toMatchObject({ cause: transportFailure })
  })
})
