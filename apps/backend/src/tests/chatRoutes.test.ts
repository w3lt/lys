import { buildChatChunk } from "./chatFixtures"
import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import {
  chatApiStreamEventSchema,
  conversationNotFoundProblemSchema,
  type ChatApiStreamEvent
} from "@lys/protocol"
import type SqliteConversationStore from "../di/services/conversationService"
import { createChatTestApp } from "./chatTestApp"

/** Valid generation request reused without mutable nested fixture state. */
const chatInput = Object.freeze({
  message: "Continue",
  model: "test",
  generationOptions: Object.freeze({ temperature: 0.7 })
})

/**
 * Parses the actual SSE bytes through the shared event contract.
 * @param body - Complete in-process HTTP response body.
 * @returns Validated application events, excluding keepalive frames.
 */
function parseEvents(body: string): ChatApiStreamEvent[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => chatApiStreamEventSchema.parse(JSON.parse(line.slice(6))))
}

/** Produces a deterministic two-delta upstream with a supported terminal marker. */
async function* createSuccessfulStream() {
  yield buildChatChunk("Hello ", null)
  yield buildChatChunk("world", "stop")
}

/** Verifies generated text and title are stored before a successful SSE exchange closes. */
async function handleStreamPersistence(context: TestContext): Promise<void> {
  const { app, store, chatService } = await createChatTestApp(context)
  context.mock.method(chatService, "completeChatStream", createSuccessfulStream)
  context.mock.method(
    chatService,
    "generateTitle",
    async () => "Generated title"
  )
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/chat",
    payload: chatInput
  })
  assert.equal(response.statusCode, 200)
  const events = parseEvents(response.body)
  const start = events[0]
  assert.ok(start?.type === "start-new-conversation-turn")
  const persisted = store
    .createHistoryAccess()
    .getConversation(start.conversation.id)
  assert.equal(persisted?.title, "Generated title")
  assert.equal(persisted?.messages[1]?.content, "Hello world")
  assert.deepEqual(
    events.filter((event) => event.type === "delta"),
    [
      { type: "delta", content: "Hello " },
      { type: "delta", content: "world" }
    ]
  )
  assert.equal(events.filter((event) => event.type === "done").length, 1)
  assert.equal(events.filter((event) => event.type === "error").length, 0)
}

/** Verifies prior context reaches the model and a renamed conversation skips title generation. */
async function handleContinuedStream(context: TestContext): Promise<void> {
  const { app, store, chatService } = await createChatTestApp(context)
  const first = createTitledConversation(store)
  const completion = context.mock.method(
    chatService,
    "completeChatStream",
    createSuccessfulStream
  )
  const title = context.mock.method(
    chatService,
    "generateTitle",
    async () => "Unexpected title"
  )
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/chat",
    payload: { ...chatInput, conversationId: first.conversation.id }
  })
  const request = completion.mock.calls[0]?.arguments[0]
  assert.ok(request)
  assert.deepEqual(request.messages, [
    { role: "system", content: first.conversation.systemPrompt },
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Continue" }
  ])
  assert.equal(title.mock.callCount(), 0)
  assert.equal(
    parseEvents(response.body)[0]?.type,
    "start-existing-conversation-turn"
  )
  assert.equal(
    store.createHistoryAccess().getConversation(first.conversation.id)?.messages
      .length,
    4
  )
}

/** Verifies a model failure retains partial text and finalizes the reply as failed. */
async function handleFailedStream(context: TestContext): Promise<void> {
  const { app, store, chatService } = await createChatTestApp(context)
  /** Emits partial content before a synthetic external inference failure. */
  async function* createFailingStream() {
    yield buildChatChunk("Partial", null)
    throw new Error("Synthetic upstream failure")
  }
  context.mock.method(chatService, "completeChatStream", createFailingStream)
  context.mock.method(chatService, "generateTitle", async () => "Title")
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/chat",
    payload: chatInput
  })
  const events = parseEvents(response.body)
  const start = events[0]
  assert.ok(start?.type === "start-new-conversation-turn")
  const assistant = store
    .createHistoryAccess()
    .getConversation(start.conversation.id)?.messages[1]
  assert.ok(assistant?.role === "assistant")
  assert.equal(assistant.content, "Partial")
  assert.equal(assistant.status, "failed")
  assert.equal(events.filter((event) => event.type === "error").length, 1)
  assert.equal(events.filter((event) => event.type === "done").length, 0)
}

/** Verifies missing conversations return Problem Details before any SSE starts. */
async function handleMissingChat(context: TestContext): Promise<void> {
  const { app, chatService } = await createChatTestApp(context)
  const generation = context.mock.method(
    chatService,
    "completeChatStream",
    createSuccessfulStream
  )
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/chat",
    payload: {
      ...chatInput,
      conversationId: "0198f5a5-7b9b-7e0b-9b0f-87d9d6a5f72d"
    }
  })
  assert.equal(response.statusCode, 404)
  assert.match(
    String(response.headers["content-type"]),
    /application\/problem\+json/
  )
  conversationNotFoundProblemSchema.parse(response.json())
  assert.equal(generation.mock.callCount(), 0)
}

/** Verifies real desktop-origin preflight allows the newly supported DELETE operation. */
async function handleDeletePreflight(context: TestContext): Promise<void> {
  const { app } = await createChatTestApp(context)
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/conversations/0198f5a5-7b9b-7e0b-9b0f-87d9d6a5f72d",
    headers: {
      origin: "tauri://localhost",
      "access-control-request-method": "DELETE"
    }
  })
  assert.equal(response.statusCode, 204)
  assert.equal(
    response.headers["access-control-allow-origin"],
    "tauri://localhost"
  )
  assert.match(
    String(response.headers["access-control-allow-methods"]),
    /DELETE/
  )
}

test(
  "SSE deltas and titles persist before successful completion",
  handleStreamPersistence
)
test(
  "continued chat sends stored context and preserves a manual title",
  handleContinuedStream
)
test(
  "upstream failure retains partial text in a failed assistant row",
  handleFailedStream
)
test(
  "missing chat conversations return the shared problem before SSE",
  handleMissingChat
)
test("Tauri DELETE preflight succeeds", handleDeletePreflight)

/**
 * Creates a completed earlier turn with a user-owned title for continuation.
 * @param store - Borrowed isolated database owner.
 * @returns The committed first turn and its saved system prompt.
 */
function createTitledConversation(store: SqliteConversationStore) {
  const turns = store.createTurnAccess()
  const first = turns.createConversationTurn({
    model: "test",
    userMessageContent: "Earlier question"
  })
  turns.updateAssistantMessageContent(
    first.assistantMessage.id,
    "Earlier answer"
  )
  turns.updateAssistantMessageState(first.assistantMessage.id, {
    status: "completed",
    finishReason: "stop"
  })
  store
    .createHistoryAccess()
    .updateConversationTitle(first.conversation.id, "Manual title")
  return first
}
