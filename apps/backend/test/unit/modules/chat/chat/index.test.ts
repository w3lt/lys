import {
  chatApiStreamEventSchema,
  conversationNotFoundProblemSchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import type SqliteConversationStore from "../../../../../src/di/services/conversationService"
import updateFastifyWithChatRoute, {
  type ChatRouteOptions
} from "../../../../../src/modules/chat/chat"
import {
  createChatRouteTestApp,
  isStreamedRequest,
  requestChat,
  respondWithChatAndTitle
} from "../../../support/chatRouteTestApp"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { findLogRecords } from "../../../support/fastifyTestApp"
import { flushMicrotasks } from "../../../support/microtasks"
import {
  createChatCompletionChunk,
  createChatCompletionStreamResponse,
  createOpenAiErrorResponse
} from "../../../support/openAiEndpointFake"

/** Settings applied by the chat route in every case. */
const CHAT_ROUTE_OPTIONS = Object.freeze({
  lysSystemPrompt: "You are Lys.",
  titleGenerationMaxAttempts: 2
} satisfies ChatRouteOptions)

/** Reply streamed by the endpoint unless a case overrides it. */
const REPLY_CHUNKS = Object.freeze([
  createChatCompletionChunk({ content: "Hi" }),
  createChatCompletionChunk({ content: " there", finishReason: "stop" })
])

/** Valid request body starting a new conversation. */
const NEW_CONVERSATION_REQUEST = Object.freeze({
  message: "Plan my trip",
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4 }
})

/**
 * Stores a completed turn and optionally titles its conversation.
 *
 * @param store - Store decorated on the test application.
 * @param title - Stored title, or null to leave the conversation untitled.
 * @returns The stored conversation identity.
 */
function storeConversation(
  store: SqliteConversationStore,
  title: string | null
): string {
  const turns = store.createTurnAccess()
  const turn = turns.createConversationTurn({
    userMessageContent: "Earlier question",
    model: "qwen/qwen3-8b",
    systemPrompt: "Stored prompt"
  })
  turns.updateAssistantMessageContent(
    turn.assistantMessage.id,
    "Earlier answer"
  )
  turns.updateAssistantMessageState(turn.assistantMessage.id, {
    status: "completed",
    finishReason: "stop"
  })
  if (title !== null) {
    store
      .createHistoryAccess()
      .updateConversationTitle(turn.conversation.id, title)
  }
  return turn.conversation.id
}

describe("updateFastifyWithChatRoute", () => {
  it("starts a new conversation, streams the reply, and publishes its generated title", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "Trip plan")
    )
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, NEW_CONVERSATION_REQUEST)

    expect(response.statusCode).toBe(200)
    expect(response.contentType).toBe("text/event-stream")
    const [start, ...generated] = response.events
    expect(start).toEqual({
      event: "start-new-conversation-turn",
      data: {
        type: "start-new-conversation-turn",
        conversation: {
          id: expect.any(String),
          title: null,
          systemPrompt: "You are Lys.",
          createdAt: expect.any(String),
          updatedAt: expect.any(String)
        },
        userMessage: expect.objectContaining({ content: "Plan my trip" }),
        assistantMessage: expect.objectContaining({
          model: "qwen/qwen3-8b",
          status: "streaming",
          content: ""
        })
      }
    })
    expect(
      generated.filter(({ event }) => event !== "title").map(({ data }) => data)
    ).toEqual([
      { type: "delta", content: "Hi" },
      { type: "delta", content: " there" },
      { type: "done", finishReason: "stop" }
    ])
    expect(generated.filter(({ event }) => event === "title")).toEqual([
      { event: "title", data: { type: "title", title: "Trip plan" } }
    ])
  })

  it("persists the new conversation, its completed reply, and its title", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "Trip plan")
    )
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, NEW_CONVERSATION_REQUEST)

    const start = chatApiStreamEventSchema.parse(response.events[0]?.data)
    if (start.type !== "start-new-conversation-turn") {
      throw new Error(`Unexpected first event ${start.type}`)
    }
    expect(
      testApp.store.createHistoryAccess().getConversation(start.conversation.id)
    ).toMatchObject({
      title: "Trip plan",
      systemPrompt: "You are Lys.",
      messages: [
        { role: "user", content: "Plan my trip" },
        {
          role: "assistant",
          content: "Hi there",
          status: "completed",
          finishReason: "stop"
        }
      ]
    })
  })

  it("forwards the stored context and generation options to the model", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "unused")
    )
    const conversationId = storeConversation(testApp.store, "Trip plan")
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    await requestChat(testApp.app, {
      conversationId,
      message: "Next question",
      model: "qwen/qwen3-8b",
      generationOptions: { temperature: 0.2, replyCeiling: 64 }
    })

    expect(testApp.endpoint.requests.map(({ body }) => body)).toEqual([
      expect.objectContaining({
        model: "qwen/qwen3-8b",
        temperature: 0.2,
        max_completion_tokens: 64,
        messages: [
          { role: "system", content: "Stored prompt" },
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Next question" }
        ]
      })
    ])
  })

  it("continues a titled conversation and replays its title without generating one", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "unused")
    )
    const conversationId = storeConversation(testApp.store, "Trip plan")
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversationId
    })

    expect(response.events.map(({ event }) => event)).toEqual([
      "start-existing-conversation-turn",
      "title",
      "delta",
      "delta",
      "done"
    ])
    expect(response.events[0]?.data).toEqual({
      type: "start-existing-conversation-turn",
      userMessage: expect.objectContaining({ content: "Plan my trip" }),
      assistantMessage: expect.objectContaining({ status: "streaming" })
    })
    expect(response.events[1]?.data).toEqual({
      type: "title",
      title: "Trip plan"
    })
    expect(
      testApp.endpoint.requests.filter(({ body }) => !isStreamedRequest(body))
    ).toEqual([])
  })

  it("generates a title for a continued conversation that has none", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "Trip plan")
    )
    const conversationId = storeConversation(testApp.store, null)
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversationId
    })

    expect(response.events[0]?.event).toBe("start-existing-conversation-turn")
    expect(response.events.filter(({ event }) => event === "title")).toEqual([
      { event: "title", data: { type: "title", title: "Trip plan" } }
    ])
    expect(
      testApp.endpoint.requests.filter(({ body }) => !isStreamedRequest(body))
    ).toHaveLength(1)
  })

  it("stops title generation at the configured attempt limit", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "   ")
    )
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, NEW_CONVERSATION_REQUEST)

    expect(response.events.map(({ event }) => event)).not.toContain("title")
    expect(
      testApp.endpoint.requests.filter(({ body }) => !isStreamedRequest(body))
    ).toHaveLength(CHAT_ROUTE_OPTIONS.titleGenerationMaxAttempts)
  })

  it("responds with the missing-conversation problem before contacting the model", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "unused")
    )
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)
    const conversationId = createFixtureUuidV7(404)

    const response = await requestChat(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversationId
    })

    expect(response.statusCode).toBe(404)
    expect(response.contentType).toMatch(/^application\/problem\+json/)
    const problem = JSON.parse(response.body)
    expect(conversationNotFoundProblemSchema.safeParse(problem).success).toBe(
      true
    )
    expect(problem).toMatchObject({
      detail: `Conversation ${conversationId} was not found.`,
      instance: "/api/v1/chat"
    })
    expect(testApp.endpoint.requests).toEqual([])
  })

  it.each([
    ["an empty message", { ...NEW_CONVERSATION_REQUEST, message: "" }],
    [
      "a conversation identifier that is not a UUIDv7",
      { ...NEW_CONVERSATION_REQUEST, conversationId: "conversation-1" }
    ],
    [
      "missing generation options",
      { message: "Plan my trip", model: "qwen/qwen3-8b" }
    ],
    ["an unknown field", { ...NEW_CONVERSATION_REQUEST, stream: true }]
  ])("rejects %s before storing a turn", async (_label, payload) => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "unused")
    )
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, payload)

    expect(response.statusCode).toBe(400)
    expect(
      testApp.store
        .createHistoryAccess()
        .listConversations({ query: "", cursor: undefined, limit: 1 })
        .storedCount
    ).toBe(0)
    expect(testApp.endpoint.requests).toEqual([])
  })

  it("reports a failed model request as an error event and stores the reply as failed", async () => {
    const testApp = await createChatRouteTestApp(() =>
      createOpenAiErrorResponse(400, "model not loaded")
    )
    const conversationId = storeConversation(testApp.store, "Trip plan")
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversationId
    })

    expect(response.events.at(-1)).toEqual({
      event: "error",
      data: {
        type: "error",
        message: "Chat completion failed. Please try again."
      }
    })
    expect(
      testApp.store
        .createHistoryAccess()
        .getConversation(conversationId)
        ?.messages.at(-1)
    ).toMatchObject({ role: "assistant", status: "failed", content: "" })
  })

  it("marks the stored reply failed and answers with a server error when the start event cannot be sent", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "unused"),
      { failingEventTypes: ["start-existing-conversation-turn"] }
    )
    const conversationId = storeConversation(testApp.store, "Trip plan")
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversationId
    })

    expect(response.statusCode).toBe(500)
    expect(response.events).toEqual([])
    expect(testApp.endpoint.requests).toEqual([])
    expect(
      testApp.store
        .createHistoryAccess()
        .getConversation(conversationId)
        ?.messages.at(-1)
    ).toMatchObject({ role: "assistant", status: "failed" })
  })

  it("logs and closes the stream when the turn cannot be finalized after streaming began", async () => {
    let closeStore: () => void = () => undefined
    const testApp = await createChatRouteTestApp((request) => {
      if (isStreamedRequest(request.body)) {
        closeStore()
      }
      return createChatCompletionStreamResponse(REPLY_CHUNKS)
    })
    closeStore = () => testApp.store[Symbol.dispose]()
    const conversationId = storeConversation(testApp.store, "Trip plan")
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)

    const response = await requestChat(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversationId
    })

    expect(response.statusCode).toBe(200)
    expect(response.events.map(({ event }) => event)).toEqual([
      "start-existing-conversation-turn",
      "title"
    ])
    expect(findLogRecords(testApp.logs, "Conversation task failed")).toEqual([
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({
          type: "AggregateError",
          message: expect.stringMatching(/^Chat failure could not be finalized/)
        })
      })
    ])
    expect(
      findLogRecords(testApp.logs, "Conversation stream finalization failed")
    ).toEqual([
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({
          message: "Conversation store is closed"
        })
      })
    ])
  })

  it("keeps the application open until an active chat request settles", async () => {
    const modelResponse = Promise.withResolvers<Response>()
    const testApp = await createChatRouteTestApp(() => modelResponse.promise)
    const conversationId = storeConversation(testApp.store, "Trip plan")
    await updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)
    const response = requestChat(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversationId
    })
    await vi.waitFor(() => expect(testApp.endpoint.requests).toHaveLength(1))

    let closed = false
    const closing = testApp.app.close().then(() => {
      closed = true
    })
    await flushMicrotasks()
    expect(closed).toBe(false)

    modelResponse.resolve(createChatCompletionStreamResponse(REPLY_CHUNKS))
    await expect(response).resolves.toMatchObject({ statusCode: 200 })
    await closing
    expect(closed).toBe(true)
  })

  it("fails registration when the conversation store is already closed", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(REPLY_CHUNKS, "unused")
    )
    testApp.store[Symbol.dispose]()

    await expect(
      updateFastifyWithChatRoute(testApp.app, CHAT_ROUTE_OPTIONS)
    ).rejects.toThrow("Conversation store is closed")
  })
})
