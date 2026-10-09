import type { MessageGenerationOptions } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import {
  readChatEvents,
  readChatReplyEvents,
  stopChatReply
} from "@/lib/apis/http/chat"
import { getConversation } from "@/lib/apis/http/conversations"
import { createChatViewStore } from "@/lib/store/chat-view"
import {
  buildJsonResponse,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream,
  type BackendRoute,
  type BackendRoutes
} from "../../../support/backendFake"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildConversationMetadata,
  buildConversationNotFoundProblem,
  buildReplyNotGeneratingProblem,
  buildStreamingAssistantMessage,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../../support/conversationFixtures"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../../support/settlement"

/** Backend origin replies and stored conversations are read from. */
const BACKEND_URL = "http://backend.test:4100"

/** Time every transition stamps on the message it changes. */
const NOW = "2026-07-08T09:10:11.123Z"

/** Route key of the chat request. */
const CHAT_ROUTE = "POST /api/v1/chat"

/** Reply the first turn of the fixture conversation streams. */
const FIRST_REPLY = buildStreamingAssistantMessage(3, "")

/** Start event of a turn that creates the fixture conversation. */
const NEW_TURN_EVENT = Object.freeze({
  type: "start-new-conversation-turn",
  conversation: buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
  userMessage: buildUserMessage(2, "Hello"),
  assistantMessage: FIRST_REPLY
})

/** Route key of the stop request for {@link FIRST_REPLY}. */
const STOP_FIRST_REPLY_ROUTE = `POST /api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${FIRST_REPLY.id}/stop`

/**
 * Creates a chat-view store over the real chat and conversation wrappers,
 * with a model and generation controls the case controls.
 *
 * @returns The store and the mutable providers: the eligible model (initially
 * `qwen3-8b`) and the generation controls.
 */
function createChatHarness() {
  const providers: {
    eligibleModel: string | null
    generationOptions: MessageGenerationOptions
  } = {
    eligibleModel: "qwen3-8b",
    generationOptions: { temperature: 0.4, replyCeiling: 256 }
  }
  const store = createChatViewStore({
    streamChat: readChatEvents,
    streamChatReply: (target, signal) =>
      readChatReplyEvents(target, { backendUrl: BACKEND_URL, signal }),
    stopChatReply: (target) =>
      stopChatReply(target, { backendUrl: BACKEND_URL }),
    getConversation: (conversationId, signal) =>
      getConversation(conversationId, { backendUrl: BACKEND_URL, signal }),
    createTimestamp: () => NOW,
    findEligibleChatModel: () => providers.eligibleModel,
    readGenerationOptions: () => providers.generationOptions
  })
  return { store, providers }
}

/**
 * Starts a backend whose chat route opens a new event stream per request.
 *
 * @param routes - Other routes the case needs.
 * @returns The backend observation handle and the opened streams in order.
 */
function startChatBackend(routes: BackendRoutes = {}) {
  const streams: BackendEventStream[] = []
  const chatRoute: BackendRoute = () => {
    const stream = startBackendEventStream()
    streams.push(stream)
    return stream.response
  }
  const backend = startBackendFake({ [CHAT_ROUTE]: chatRoute, ...routes })
  return { backend, streams }
}

/**
 * Sends events on a stream and waits until the store applied them.
 *
 * @param stream - Stream the backend writes.
 * @param events - Event payloads in sending order.
 */
async function sendStreamEvents(
  stream: BackendEventStream | undefined,
  ...events: unknown[]
): Promise<void> {
  events.forEach((event) => stream?.sendEvent(event))
  await waitForMicrotasks()
}

/**
 * Starts a new conversation whose reply is streaming.
 *
 * @param routes - Other routes the case needs.
 * @returns The harness, the backend, the chat streams, and the pending send.
 */
async function startStreamingReply(routes: BackendRoutes = {}) {
  const chat = startChatBackend(routes)
  const harness = createChatHarness()
  harness.store.getState().setInputDraft("Hello")
  const send = harness.store.getState().sendMessage()
  await waitForMicrotasks()
  await sendStreamEvents(chat.streams[0], NEW_TURN_EVENT)
  return { ...harness, ...chat, send }
}

/**
 * Lists the route keys of the requests a backend received, in order.
 *
 * @param backend - Backend observation handle.
 * @returns `<METHOD> <path>` of each request.
 */
function listRouteKeys(backend: ReturnType<typeof startBackendFake>) {
  return backend.requests.map(
    (request) => `${request.method} ${new URL(request.url).pathname}`
  )
}

describe("createChatViewStore", () => {
  it("starts empty and idle", () => {
    expect(createChatHarness().store.getState()).toMatchObject({
      inputDraft: "",
      conversation: undefined,
      request: { status: "idle" },
      conversationOpen: { status: "idle" },
      error: undefined
    })
  })

  describe("sendMessage", () => {
    it("starts a new Lys conversation with the trimmed draft, the eligible model, and the generation controls", async () => {
      const { backend, streams } = startChatBackend()
      const { store } = createChatHarness()
      store.getState().setInputDraft("  Hello  ")

      void store.getState().sendMessage()
      const whileAwaiting = store.getState().request
      await waitForMicrotasks()

      expect(whileAwaiting).toMatchObject({ status: "awaiting-turn" })
      expect(backend.requests[0]?.body).toEqual({
        conversation: { kind: "new", agentCode: "lys" },
        message: "Hello",
        model: "qwen3-8b",
        generationOptions: { temperature: 0.4, replyCeiling: 256 }
      })
      streams[0]?.close()
    })

    it("shows the started turn, clears the unchanged draft, and streams the reply", async () => {
      const { store } = await startStreamingReply()

      expect(store.getState()).toMatchObject({
        inputDraft: "",
        request: {
          status: "reply-streaming",
          assistantMessageId: FIRST_REPLY.id
        },
        conversation: {
          id: FIXTURE_CONVERSATION_ID,
          messages: [NEW_TURN_EVENT.userMessage, FIRST_REPLY]
        }
      })
    })

    it("keeps a draft typed after submitting", async () => {
      const { streams } = startChatBackend()
      const { store } = createChatHarness()
      store.getState().setInputDraft("Hello")
      void store.getState().sendMessage()
      await waitForMicrotasks()

      store.getState().setInputDraft("Next question")
      await sendStreamEvents(streams[0], NEW_TURN_EVENT)

      expect(store.getState().inputDraft).toBe("Next question")
    })

    it("sends a starter prompt without touching the draft", async () => {
      const { backend, streams } = startChatBackend()
      const { store } = createChatHarness()
      store.getState().setInputDraft("half-typed")

      void store.getState().sendMessage("What are you?")
      await waitForMicrotasks()
      await sendStreamEvents(streams[0], NEW_TURN_EVENT)

      expect(backend.requests[0]?.body).toMatchObject({
        message: "What are you?"
      })
      expect(store.getState().inputDraft).toBe("half-typed")
    })

    it("continues the shown conversation and appends the new turn", async () => {
      const { store, backend, streams, send } = await startStreamingReply()
      await sendStreamEvents(streams[0], { type: "done", finishReason: "stop" })
      streams[0]?.close()
      await send
      const secondReply = buildStreamingAssistantMessage(5, "")

      store.getState().setInputDraft("More")
      void store.getState().sendMessage()
      await waitForMicrotasks()
      await sendStreamEvents(streams[1], {
        type: "start-existing-conversation-turn",
        userMessage: buildUserMessage(4, "More"),
        assistantMessage: secondReply
      })

      expect(backend.requests.at(-1)?.body).toMatchObject({
        conversation: { kind: "existing", id: FIXTURE_CONVERSATION_ID }
      })
      expect(
        store.getState().conversation?.messages.map((message) => message.id)
      ).toEqual([
        NEW_TURN_EVENT.userMessage.id,
        FIRST_REPLY.id,
        buildUserMessage(4, "More").id,
        secondReply.id
      ])
    })

    it("records why chat is unavailable without a loaded model and keeps the draft", async () => {
      const { backend } = startChatBackend()
      const { store, providers } = createChatHarness()
      providers.eligibleModel = null
      store.getState().setInputDraft("Hello")

      await store.getState().sendMessage()

      expect(store.getState()).toMatchObject({
        inputDraft: "Hello",
        request: { status: "idle" },
        error: expect.stringContaining("Chat is unavailable")
      })
      expect(backend.requests).toEqual([])
    })

    it("ignores a blank prompt", async () => {
      const { backend } = startChatBackend()
      const { store } = createChatHarness()
      store.getState().setInputDraft("   ")

      await store.getState().sendMessage()

      expect(backend.requests).toEqual([])
    })

    it("ignores a second message while a reply is awaited or streaming", async () => {
      const chat = startChatBackend()
      const { store } = createChatHarness()
      store.getState().setInputDraft("Hello")
      void store.getState().sendMessage()
      await store.getState().sendMessage("While awaiting")
      await waitForMicrotasks()
      await sendStreamEvents(chat.streams[0], NEW_TURN_EVENT)

      await store.getState().sendMessage("While streaming")

      expect(listRouteKeys(chat.backend)).toEqual([CHAT_ROUTE])
    })

    it("clears an earlier error when a request starts", async () => {
      startChatBackend()
      const { store, providers } = createChatHarness()
      providers.eligibleModel = null
      await store.getState().sendMessage("Hello")
      providers.eligibleModel = "qwen3-8b"

      void store.getState().sendMessage("Hello")

      expect(store.getState().error).toBeUndefined()
    })
  })

  describe("streamed events", () => {
    it("appends deltas, completes the reply with its finish reason, then returns to idle", async () => {
      const { store, streams, send } = await startStreamingReply()

      await sendStreamEvents(
        streams[0],
        { type: "delta", content: "Hi" },
        { type: "delta", content: " there" },
        { type: "done", finishReason: "length" }
      )
      const afterDone = store.getState().request
      streams[0]?.close()
      await send

      expect(afterDone).toMatchObject({ status: "reply-completed" })
      expect(store.getState().request).toEqual({ status: "idle" })
      expect(store.getState().conversation?.messages.at(-1)).toEqual({
        ...FIRST_REPLY,
        content: "Hi there",
        status: "completed",
        finishReason: "length",
        updatedAt: NOW
      })
      expect(store.getState().error).toBeUndefined()
    })

    it("applies a title that arrives after the reply completed", async () => {
      const { store, streams, send } = await startStreamingReply()

      await sendStreamEvents(
        streams[0],
        { type: "done", finishReason: "stop" },
        { type: "title", title: "Greeting" }
      )
      streams[0]?.close()
      await send

      expect(store.getState().conversation?.title).toBe("Greeting")
    })

    it("shows a reply the backend interrupted", async () => {
      const { store, streams, send } = await startStreamingReply()

      await sendStreamEvents(
        streams[0],
        { type: "delta", content: "Par" },
        { type: "interrupted" }
      )
      streams[0]?.close()
      await send

      expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
        content: "Par",
        status: "interrupted",
        finishReason: null
      })
      expect(store.getState().error).toBeUndefined()
    })

    it("fails the reply and shows the error the backend reported", async () => {
      const { store, streams, send } = await startStreamingReply()

      await sendStreamEvents(streams[0], {
        type: "error",
        message: "Model crashed."
      })
      streams[0]?.close()
      await send

      expect(store.getState()).toMatchObject({
        error: "Model crashed.",
        request: { status: "idle" }
      })
      expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
        status: "failed"
      })
    })

    it("shows an error the backend reported before the turn started", async () => {
      const { streams } = startChatBackend()
      const { store } = createChatHarness()
      const send = store.getState().sendMessage("Hello")
      await waitForMicrotasks()

      await sendStreamEvents(streams[0], {
        type: "error",
        message: "Model not loaded."
      })
      streams[0]?.close()
      await send

      expect(store.getState()).toMatchObject({
        error: "Model not loaded.",
        conversation: undefined,
        request: { status: "idle" }
      })
    })

    it("fails a reply whose stream ends before it is final", async () => {
      const { store, streams, send } = await startStreamingReply()

      streams[0]?.close()
      await send

      expect(store.getState().error).toBe(
        "Chat stream ended before completion."
      )
      expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
        status: "failed"
      })
    })

    it("fails a reply whose stream breaks its contract", async () => {
      const { store, streams, send } = await startStreamingReply()

      streams[0]?.sendText("data: {not json\n\n")
      await send

      expect(store.getState()).toMatchObject({
        request: { status: "idle" },
        error: expect.any(String)
      })
      expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
        status: "failed"
      })
    })

    it("shows why the chat request failed", async () => {
      startBackendFake({ [CHAT_ROUTE]: () => buildJsonResponse(503, {}) })
      const { store } = createChatHarness()

      await store.getState().sendMessage("Hello")

      expect(store.getState()).toMatchObject({
        request: { status: "idle" },
        error: expect.stringContaining("503")
      })
    })

    it("stops following a completed reply's stream when the next message is sent", async () => {
      const { store, streams } = await startStreamingReply()
      await sendStreamEvents(streams[0], { type: "done", finishReason: "stop" })

      void store.getState().sendMessage("Next")
      await waitForMicrotasks()
      await sendStreamEvents(streams[0], { type: "title", title: "Late title" })

      expect(streams[0]?.isCancelled()).toBe(true)
      expect(store.getState().conversation?.title).toBeNull()
    })
  })

  describe("stopStreaming", () => {
    it("asks the backend to stop a streaming reply and shows it interrupted once the stream says so", async () => {
      const { store, backend, streams, send } = await startStreamingReply({
        [STOP_FIRST_REPLY_ROUTE]: () => new Response(null, { status: 204 })
      })

      await store.getState().stopStreaming()
      const afterStop = store.getState().conversation?.messages.at(-1)
      await sendStreamEvents(streams[0], { type: "interrupted" })
      streams[0]?.close()
      await send

      expect(listRouteKeys(backend)).toContain(STOP_FIRST_REPLY_ROUTE)
      expect(afterStop).toMatchObject({ status: "streaming" })
      expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
        status: "interrupted"
      })
    })

    it("sends a stop requested before the turn started as soon as the reply is known", async () => {
      const { backend, streams } = startChatBackend({
        [STOP_FIRST_REPLY_ROUTE]: () => new Response(null, { status: 204 })
      })
      const { store } = createChatHarness()
      void store.getState().sendMessage("Hello")
      await waitForMicrotasks()

      await store.getState().stopStreaming()
      const beforeTurn = listRouteKeys(backend)
      await sendStreamEvents(streams[0], NEW_TURN_EVENT)

      expect(beforeTurn).toEqual([CHAT_ROUTE])
      expect(listRouteKeys(backend)).toEqual([
        CHAT_ROUTE,
        STOP_FIRST_REPLY_ROUTE
      ])
      streams[0]?.close()
    })

    it("accepts a reply that already finished generating", async () => {
      const { store } = await startStreamingReply({
        [STOP_FIRST_REPLY_ROUTE]: () =>
          buildJsonResponse(409, buildReplyNotGeneratingProblem())
      })

      await store.getState().stopStreaming()

      expect(store.getState().error).toBeUndefined()
    })

    it("shows a failed stop and keeps reading the reply", async () => {
      const { store, streams } = await startStreamingReply({
        [STOP_FIRST_REPLY_ROUTE]: () => buildJsonResponse(500, {})
      })

      await store.getState().stopStreaming()
      await sendStreamEvents(streams[0], { type: "delta", content: "more" })

      expect(store.getState().error).toMatch(
        /^The reply could not be stopped: .*500/
      )
      expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
        content: "more",
        status: "streaming"
      })
    })

    it("only stops following once the reply completed, without asking the backend", async () => {
      const { store, backend, streams } = await startStreamingReply()
      await sendStreamEvents(streams[0], { type: "done", finishReason: "stop" })

      await store.getState().stopStreaming()
      await waitForMicrotasks()

      expect(store.getState().request).toEqual({ status: "idle" })
      expect(streams[0]?.isCancelled()).toBe(true)
      expect(listRouteKeys(backend)).toEqual([CHAT_ROUTE])
    })

    it("does nothing without a request", async () => {
      const { backend } = startChatBackend()
      const { store } = createChatHarness()

      await store.getState().stopStreaming()

      expect(backend.requests).toEqual([])
    })
  })

  describe("resetConversation", () => {
    it("restores the initial state and stops following without stopping the reply", async () => {
      const { store, backend, streams, send } = await startStreamingReply()
      store.getState().setInputDraft("draft")

      store.getState().resetConversation()
      await sendStreamEvents(streams[0], { type: "delta", content: "late" })
      await send

      expect(store.getState()).toMatchObject({
        inputDraft: "",
        conversation: undefined,
        request: { status: "idle" },
        error: undefined
      })
      expect(streams[0]?.isCancelled()).toBe(true)
      expect(listRouteKeys(backend)).toEqual([CHAT_ROUTE])
    })
  })
})

/** Stored conversation another case opens; its last reply is final. */
const STORED_ID = createFixtureUuidV7(20)
const STORED_CONVERSATION = buildConversation(STORED_ID, "Stored", [
  buildUserMessage(21, "Earlier"),
  buildCompletedAssistantMessage(22, "Earlier answer")
])

/** Stored conversation whose last reply is still generating. */
const GENERATING_ID = createFixtureUuidV7(30)
const GENERATING_REPLY = buildStreamingAssistantMessage(32, "Partial")
const GENERATING_CONVERSATION = buildConversation(GENERATING_ID, null, [
  buildUserMessage(31, "Question"),
  GENERATING_REPLY
])

/** Route key of the reply-events endpoint for {@link GENERATING_REPLY}. */
const GENERATING_EVENTS_ROUTE = `GET /api/v1/chat/${GENERATING_ID}/replies/${GENERATING_REPLY.id}/events`

/**
 * Builds a route that reads a stored conversation.
 *
 * @param conversation - Stored conversation the backend returns.
 * @returns The route key and the route.
 */
function answerStoredConversation(conversation: {
  readonly id: string
}): BackendRoutes {
  return {
    [`GET /api/v1/conversations/${conversation.id}`]: () =>
      buildJsonResponse(200, conversation)
  }
}

/**
 * Starts a backend whose reply-events route for {@link GENERATING_REPLY}
 * opens a new event stream per request.
 *
 * @param routes - Other routes the case needs.
 * @returns The backend observation handle and the opened reply streams.
 */
function startFollowBackend(routes: BackendRoutes) {
  const replyStreams: BackendEventStream[] = []
  const backend = startBackendFake({
    [GENERATING_EVENTS_ROUTE]: () => {
      const stream = startBackendEventStream()
      replyStreams.push(stream)
      return stream.response
    },
    ...routes
  })
  return { backend, replyStreams }
}

/** Snapshot that starts following {@link GENERATING_REPLY}. */
const GENERATING_SNAPSHOT_EVENT = Object.freeze({
  type: "reply-snapshot",
  conversationTitle: "Named meanwhile",
  assistantMessage: buildStreamingAssistantMessage(32, "Partial answer")
})

describe("openConversation", () => {
  it("keeps the shown conversation while reading, then shows the stored one and clears the unchanged draft", async () => {
    const read = createControlledPromise<Response>()
    startBackendFake({
      [`GET /api/v1/conversations/${STORED_ID}`]: () => read.promise
    })
    const { store } = createChatHarness()
    store.getState().setInputDraft("old draft")

    const open = store.getState().openConversation(STORED_ID)
    const whileOpening = store.getState()
    read.resolve(buildJsonResponse(200, STORED_CONVERSATION))
    await open

    expect(whileOpening).toMatchObject({
      conversation: undefined,
      conversationOpen: { status: "opening", conversationId: STORED_ID }
    })
    expect(store.getState()).toMatchObject({
      conversation: STORED_CONVERSATION,
      inputDraft: "",
      conversationOpen: { status: "idle" },
      request: { status: "idle" },
      error: undefined
    })
  })

  it("keeps text typed while the conversation opens", async () => {
    const read = createControlledPromise<Response>()
    startBackendFake({
      [`GET /api/v1/conversations/${STORED_ID}`]: () => read.promise
    })
    const { store } = createChatHarness()
    const open = store.getState().openConversation(STORED_ID)

    store.getState().setInputDraft("typed while opening")
    read.resolve(buildJsonResponse(200, STORED_CONVERSATION))
    await open

    expect(store.getState().inputDraft).toBe("typed while opening")
  })

  it("ignores opening the conversation already shown", async () => {
    const backend = startBackendFake(
      answerStoredConversation(STORED_CONVERSATION)
    )
    const { store } = createChatHarness()
    await store.getState().openConversation(STORED_ID)

    await store.getState().openConversation(STORED_ID)

    expect(backend.requests).toHaveLength(1)
  })

  it("stops following the active reply without stopping it on the backend", async () => {
    const { store, backend, streams } = await startStreamingReply(
      answerStoredConversation(STORED_CONVERSATION)
    )

    await store.getState().openConversation(STORED_ID)

    expect(streams[0]?.isCancelled()).toBe(true)
    expect(listRouteKeys(backend)).not.toContain(STOP_FIRST_REPLY_ROUTE)
    expect(store.getState().conversation?.id).toBe(STORED_ID)
  })

  it("keeps the shown conversation and reports a conversation that no longer exists", async () => {
    const { store, streams, send } = await startStreamingReply({
      [`GET /api/v1/conversations/${STORED_ID}`]: () =>
        buildJsonResponse(404, buildConversationNotFoundProblem())
    })
    await sendStreamEvents(streams[0], { type: "done", finishReason: "stop" })
    streams[0]?.close()
    await send

    await store.getState().openConversation(STORED_ID)

    expect(store.getState()).toMatchObject({
      conversation: { id: FIXTURE_CONVERSATION_ID },
      conversationOpen: { status: "idle" },
      error: "That conversation no longer exists."
    })
  })

  it("keeps the shown conversation and reports why it could not be opened", async () => {
    startBackendFake({
      [`GET /api/v1/conversations/${STORED_ID}`]: () =>
        buildJsonResponse(500, {})
    })
    const { store } = createChatHarness()

    await store.getState().openConversation(STORED_ID)

    expect(store.getState()).toMatchObject({
      conversation: undefined,
      error: expect.stringMatching(
        /^The conversation could not be opened: .*500/
      )
    })
  })

  it("lets a newer open replace a pending one, whose late answer is ignored", async () => {
    const olderRead = createControlledPromise<Response>()
    const backend = startBackendFake({
      [`GET /api/v1/conversations/${GENERATING_ID}`]: () => olderRead.promise,
      ...answerStoredConversation(STORED_CONVERSATION)
    })
    const { store } = createChatHarness()
    const older = store.getState().openConversation(GENERATING_ID)

    await store.getState().openConversation(STORED_ID)
    olderRead.resolve(buildJsonResponse(200, GENERATING_CONVERSATION))
    await older

    expect(store.getState().conversation?.id).toBe(STORED_ID)
    expect(backend.requests[0]?.signal?.aborted).toBe(true)
  })

  it("ignores a read that answers after the conversation was reset", async () => {
    const read = createControlledPromise<Response>()
    startBackendFake({
      [`GET /api/v1/conversations/${STORED_ID}`]: () => read.promise
    })
    const { store } = createChatHarness()
    const open = store.getState().openConversation(STORED_ID)

    store.getState().resetConversation()
    read.resolve(buildJsonResponse(200, STORED_CONVERSATION))
    await open

    expect(store.getState()).toMatchObject({
      conversation: undefined,
      conversationOpen: { status: "idle" }
    })
  })

  it("does not send while a conversation opens", async () => {
    const read = createControlledPromise<Response>()
    const backend = startBackendFake({
      [`GET /api/v1/conversations/${STORED_ID}`]: () => read.promise
    })
    const { store } = createChatHarness()
    const open = store.getState().openConversation(STORED_ID)

    await store.getState().sendMessage("Hello")
    read.resolve(buildJsonResponse(200, STORED_CONVERSATION))
    await open

    expect(listRouteKeys(backend)).toEqual([
      `GET /api/v1/conversations/${STORED_ID}`
    ])
  })
})

describe("following a stored reply", () => {
  it("follows a reply still generating from its snapshot to its end", async () => {
    const { replyStreams } = startFollowBackend(
      answerStoredConversation(GENERATING_CONVERSATION)
    )
    const { store } = createChatHarness()
    const open = store.getState().openConversation(GENERATING_ID)
    await waitForMicrotasks()
    const whileFollowing = store.getState().request

    await sendStreamEvents(
      replyStreams[0],
      GENERATING_SNAPSHOT_EVENT,
      { type: "delta", content: "!" },
      { type: "done", finishReason: "stop" }
    )
    replyStreams[0]?.close()
    await open

    expect(whileFollowing).toMatchObject({
      status: "reply-streaming",
      assistantMessageId: GENERATING_REPLY.id
    })
    expect(store.getState().request).toEqual({ status: "idle" })
    expect(store.getState().conversation).toMatchObject({
      title: "Named meanwhile",
      messages: [
        { id: createFixtureUuidV7(31) },
        {
          id: GENERATING_REPLY.id,
          content: "Partial answer!",
          status: "completed",
          finishReason: "stop"
        }
      ]
    })
  })

  it("shows the reply interrupted when its stream does not start with a snapshot", async () => {
    const { replyStreams } = startFollowBackend(
      answerStoredConversation(GENERATING_CONVERSATION)
    )
    const { store } = createChatHarness()
    const open = store.getState().openConversation(GENERATING_ID)
    await waitForMicrotasks()

    await sendStreamEvents(replyStreams[0], { type: "delta", content: "x" })
    await open

    expect(store.getState().error).toBe(
      "Reply stream did not start with a snapshot."
    )
    expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
      content: "Partial",
      status: "interrupted"
    })
  })

  it("shows the reply interrupted when its stream ends before the reply is final", async () => {
    const { replyStreams } = startFollowBackend(
      answerStoredConversation(GENERATING_CONVERSATION)
    )
    const { store } = createChatHarness()
    const open = store.getState().openConversation(GENERATING_ID)
    await waitForMicrotasks()

    await sendStreamEvents(replyStreams[0], GENERATING_SNAPSHOT_EVENT)
    replyStreams[0]?.close()
    await open

    expect(store.getState().error).toBe(
      "Stopped following the reply before it finished."
    )
    expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
      content: "Partial answer",
      status: "interrupted"
    })
  })

  it("reports a followed reply the backend no longer stores", async () => {
    startBackendFake({
      ...answerStoredConversation(GENERATING_CONVERSATION),
      [GENERATING_EVENTS_ROUTE]: () =>
        buildJsonResponse(404, buildConversationNotFoundProblem())
    })
    const { store } = createChatHarness()

    await store.getState().openConversation(GENERATING_ID)

    expect(store.getState().error).toBe("The reply is no longer stored.")
    expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
      status: "interrupted"
    })
  })

  it("asks the backend to stop a followed reply", async () => {
    const stopRoute = `POST /api/v1/chat/${GENERATING_ID}/replies/${GENERATING_REPLY.id}/stop`
    const { backend, replyStreams } = startFollowBackend({
      ...answerStoredConversation(GENERATING_CONVERSATION),
      [stopRoute]: () => new Response(null, { status: 204 })
    })
    const { store } = createChatHarness()
    const open = store.getState().openConversation(GENERATING_ID)
    await waitForMicrotasks()
    await sendStreamEvents(replyStreams[0], GENERATING_SNAPSHOT_EVENT)

    await store.getState().stopStreaming()
    await sendStreamEvents(replyStreams[0], { type: "interrupted" })
    replyStreams[0]?.close()
    await open

    expect(listRouteKeys(backend)).toContain(stopRoute)
    expect(store.getState().conversation?.messages.at(-1)).toMatchObject({
      status: "interrupted"
    })
  })

  it("follows the shown reply again from a fresh snapshot after a failed open", async () => {
    const { replyStreams } = startFollowBackend({
      ...answerStoredConversation(GENERATING_CONVERSATION),
      [`GET /api/v1/conversations/${STORED_ID}`]: () =>
        buildJsonResponse(500, {})
    })
    const { store } = createChatHarness()
    void store.getState().openConversation(GENERATING_ID)
    await waitForMicrotasks()
    await sendStreamEvents(replyStreams[0], GENERATING_SNAPSHOT_EVENT)

    const failedOpen = store.getState().openConversation(STORED_ID)
    await waitForMicrotasks()
    await sendStreamEvents(replyStreams[1], {
      ...GENERATING_SNAPSHOT_EVENT,
      assistantMessage: buildStreamingAssistantMessage(
        32,
        "Partial answer, longer"
      )
    })
    const whileRefollowing = store.getState()
    replyStreams[1]?.close()
    await failedOpen

    expect(replyStreams[0]?.isCancelled()).toBe(true)
    expect(whileRefollowing).toMatchObject({
      request: { status: "reply-streaming" },
      error: expect.stringMatching(/^The conversation could not be opened/)
    })
    expect(whileRefollowing.conversation?.messages.at(-1)).toMatchObject({
      content: "Partial answer, longer"
    })
  })
})

describe("closeConversation", () => {
  it("resets the view when it shows the closed conversation", async () => {
    startBackendFake(answerStoredConversation(STORED_CONVERSATION))
    const { store } = createChatHarness()
    await store.getState().openConversation(STORED_ID)
    store.getState().setInputDraft("draft")

    store.getState().closeConversation(STORED_ID)

    expect(store.getState()).toMatchObject({
      conversation: undefined,
      inputDraft: ""
    })
  })

  it("abandons opening the closed conversation", async () => {
    const read = createControlledPromise<Response>()
    startBackendFake({
      [`GET /api/v1/conversations/${STORED_ID}`]: () => read.promise
    })
    const { store } = createChatHarness()
    const open = store.getState().openConversation(STORED_ID)

    store.getState().closeConversation(STORED_ID)
    read.resolve(buildJsonResponse(200, STORED_CONVERSATION))
    await open

    expect(store.getState()).toMatchObject({
      conversation: undefined,
      conversationOpen: { status: "idle" }
    })
  })

  it("changes nothing for a conversation the view does not present", async () => {
    startBackendFake(answerStoredConversation(STORED_CONVERSATION))
    const { store } = createChatHarness()
    await store.getState().openConversation(STORED_ID)
    const before = store.getState()

    store.getState().closeConversation(GENERATING_ID)

    expect(store.getState()).toBe(before)
  })

  it("keeps the shown conversation open while another one opens to replace it", async () => {
    const read = createControlledPromise<Response>()
    startBackendFake({
      ...answerStoredConversation(STORED_CONVERSATION),
      [`GET /api/v1/conversations/${GENERATING_ID}`]: () => read.promise
    })
    const { store } = createChatHarness()
    await store.getState().openConversation(STORED_ID)
    const open = store.getState().openConversation(GENERATING_ID)

    store.getState().closeConversation(STORED_ID)
    const afterClose = store.getState().conversationOpen
    read.resolve(
      buildJsonResponse(200, buildConversation(GENERATING_ID, null, []))
    )
    await open

    expect(afterClose).toMatchObject({
      status: "opening",
      conversationId: GENERATING_ID
    })
    expect(store.getState().conversation?.id).toBe(GENERATING_ID)
  })
})

describe("useChatViewStore", () => {
  /**
   * Imports fresh application and chat-view stores, with a running backend
   * at {@link BACKEND_URL} that has loaded `resident` weights.
   *
   * @param replyCeiling - Saved reply ceiling; zero means no limit.
   * @returns Both store hooks.
   */
  async function importFreshChatViewStore(replyCeiling: number) {
    vi.resetModules()
    const { useLysStore } = await import("@/lib/store")
    const { useChatViewStore } = await import("@/lib/store/chat-view")
    const { settings } = useLysStore.getState()
    useLysStore.setState({
      backendUrl: BACKEND_URL,
      backendServerInfo: { status: "running" },
      modelRuntime: { status: "loaded", modelKey: "resident" },
      settings: {
        ...settings,
        generation: { temperature: 0.3, replyCeiling }
      }
    })
    return { useLysStore, useChatViewStore }
  }

  it.each([
    [512, { temperature: 0.3, replyCeiling: 512 }],
    [0, { temperature: 0.3 }]
  ])(
    "sends with the loaded model and a saved ceiling of %d as %o",
    async (replyCeiling, generationOptions) => {
      const { backend, streams } = startChatBackend()
      const { useChatViewStore } = await importFreshChatViewStore(replyCeiling)

      void useChatViewStore.getState().sendMessage("Hello")
      await waitForMicrotasks()

      expect(backend.requests[0]?.body).toEqual({
        conversation: { kind: "new", agentCode: "lys" },
        message: "Hello",
        model: "resident",
        generationOptions
      })
      streams[0]?.close()
    }
  )

  it("refuses to send while the backend is not running", async () => {
    const { backend } = startChatBackend()
    const { useLysStore, useChatViewStore } = await importFreshChatViewStore(0)
    useLysStore.setState({ backendServerInfo: { status: "stopping" } })

    await useChatViewStore.getState().sendMessage("Hello")

    expect(backend.requests).toEqual([])
    expect(useChatViewStore.getState().error).toContain("Chat is unavailable")
  })

  it("reads stored conversations and follows replies at the application store's backend", async () => {
    const { backend, replyStreams } = startFollowBackend(
      answerStoredConversation(GENERATING_CONVERSATION)
    )
    const { useChatViewStore } = await importFreshChatViewStore(0)

    const open = useChatViewStore.getState().openConversation(GENERATING_ID)
    await waitForMicrotasks()
    replyStreams[0]?.close()
    await open

    expect(
      backend.requests.map((request) => new URL(request.url).origin)
    ).toEqual([BACKEND_URL, BACKEND_URL])
  })
})
