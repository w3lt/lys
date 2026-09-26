import { buildChatChunk, chatTestInput } from "./chatFixtures"
import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import type { SSESource } from "@fastify/sse"
import { chatApi, type ChatApiRoute } from "@lys/protocol"
import { createChatTestApp } from "./chatTestApp"
import type SqliteConversationStore from "../di/services/conversationService"
import createChatTask from "../modules/chat/chat/chatTask"
import type {
  ChatRouteRequest,
  ChatRouteReply
} from "../modules/chat/chat/share"

/**
 * Emits text, then emulates upstream rejection after caller cancellation.
 * @param controller - Test owner of the cancellation event.
 * @returns A partial reply followed by an explicit cancellation failure.
 */
async function* createCancelledStream(
  controller: AbortController
): AsyncGenerator<ChatCompletionChunk> {
  yield buildChatChunk("Partial reply", null)
  controller.abort()
  throw new Error("Synthetic abort")
}

/**
 * Binds an interrupted completion to one real persisted conversation turn.
 * @param store - Borrowed isolated storage for the lifetime of the test route.
 * @returns A request handler and the persisted conversation identity for assertions.
 */
function createInterruptedTaskSetup(store: SqliteConversationStore) {
  const controller = new AbortController()
  const turns = store.createTurnAccess()
  const turn = turns.createConversationTurn({
    systemPrompt: "Test system prompt",
    model: "test",
    userMessageContent: "Prompt"
  })
  /**
   * Exercises the production chat task over a real SSE reply and SQLite callbacks.
   * @param request - Validated test request and logger.
   * @param reply - SSE output owned by the test route.
   * @returns Settlement after interrupted-message persistence.
   */
  async function handleRequest(
    request: ChatRouteRequest,
    reply: ChatRouteReply
  ): Promise<void> {
    await createChatTask({
      request,
      reply,
      abortSignal: controller.signal,
      completeChatStream: async () => createCancelledStream(controller),
      model: "test",
      messages: [{ role: "user", content: "Prompt" }],
      generationOptions: { temperature: 0.7 },
      updateAssistantMessageContent: (content) =>
        turns.updateAssistantMessageContent(turn.assistantMessage.id, content),
      updateAssistantMessageState: (completion) =>
        turns.updateAssistantMessageState(turn.assistantMessage.id, completion)
    })
  }
  return { conversationId: turn.conversation.id, handleRequest }
}

/**
 * Verifies explicit model cancellation retains partial content as interrupted.
 * @param context - Runner owner of isolated app/store resources.
 */
async function handleInterruptedTask(context: TestContext): Promise<void> {
  const { app, store } = await createChatTestApp(context)
  const { conversationId, handleRequest } = createInterruptedTaskSetup(store)
  app.route<ChatApiRoute>({
    method: "POST",
    url: "/task",
    sse: "only",
    schema: { body: chatApi.body },
    handler: handleRequest
  })
  const response = await app.inject({
    method: "POST",
    url: "/task",
    payload: chatTestInput
  })
  const message = store.createHistoryAccess().getConversation(conversationId)
    ?.messages[1]
  assert.ok(message?.role === "assistant")
  assert.equal(message.content, "Partial reply")
  assert.equal(message.status, "interrupted")
  assert.equal(message.finishReason, null)
  assert.doesNotMatch(response.body, /event: done|event: error/)
}

/**
 * Emits one complete reply.
 * @returns A single delta that also carries the stop marker.
 */
async function* createCompletedStream(): AsyncGenerator<ChatCompletionChunk> {
  yield buildChatChunk("Complete reply", "stop")
}

/**
 * Reports whether an SSE write carries the terminal chat `done` event.
 * @param source - Write requested by the chat task.
 * @returns True only for the protocol's done event message.
 */
function isChatDoneEvent(source: SSESource): boolean {
  return (
    typeof source === "object" && "event" in source && source.event === "done"
  )
}

/**
 * Creates an SSE writer whose terminal done write fails as a lost connection would.
 * @param sendSseSource - Real writer receiving every other event.
 * @returns A writer rejecting only the done event.
 */
function createLostDoneEventWriter(
  sendSseSource: (source: SSESource) => Promise<void>
): (source: SSESource) => Promise<void> {
  /**
   * Forwards one write unless it is the terminal done event.
   * @param source - Write requested by the chat task.
   * @returns Settlement after the real write.
   * @throws For the done event, before anything is written.
   */
  async function sendUnlessDone(source: SSESource): Promise<void> {
    if (isChatDoneEvent(source)) throw new Error("Synthetic lost done event")
    await sendSseSource(source)
  }
  return sendUnlessDone
}

/**
 * Binds a completed reply whose done event cannot be written to one persisted turn.
 * @param context - Runner owner restoring the SSE writer substitution.
 * @param store - Borrowed isolated storage for the lifetime of the test route.
 * @returns A request handler and the persisted conversation identity for assertions.
 */
function createLostDoneTaskSetup(
  context: TestContext,
  store: SqliteConversationStore
) {
  const turns = store.createTurnAccess()
  const turn = turns.createConversationTurn({
    systemPrompt: "Test system prompt",
    model: "test",
    userMessageContent: "Prompt"
  })
  /**
   * Exercises the production chat task with a failing terminal SSE write.
   * @param request - Validated test request and logger.
   * @param reply - SSE output owned by the test route.
   * @returns Settlement after the task completes.
   */
  async function handleRequest(
    request: ChatRouteRequest,
    reply: ChatRouteReply
  ): Promise<void> {
    const sse = reply.sse
    context.mock.method(
      sse,
      "send",
      createLostDoneEventWriter(sse.send.bind(sse))
    )
    await createChatTask({
      request,
      reply,
      abortSignal: new AbortController().signal,
      completeChatStream: async () => createCompletedStream(),
      model: "test",
      messages: [{ role: "user", content: "Prompt" }],
      generationOptions: { temperature: 0.7 },
      updateAssistantMessageContent: (content) =>
        turns.updateAssistantMessageContent(turn.assistantMessage.id, content),
      updateAssistantMessageState: (completion) =>
        turns.updateAssistantMessageState(turn.assistantMessage.id, completion)
    })
  }
  return { conversationId: turn.conversation.id, handleRequest }
}

/**
 * Verifies a lost done event leaves the persisted completion without a failure event.
 * @param context - Runner owner of isolated app/store resources and mocks.
 */
async function handleLostDoneEvent(context: TestContext): Promise<void> {
  const { app, store } = await createChatTestApp(context)
  const { conversationId, handleRequest } = createLostDoneTaskSetup(
    context,
    store
  )
  app.route<ChatApiRoute>({
    method: "POST",
    url: "/task",
    sse: "only",
    schema: { body: chatApi.body },
    handler: handleRequest
  })
  const response = await app.inject({
    method: "POST",
    url: "/task",
    payload: chatTestInput
  })
  const message = store.createHistoryAccess().getConversation(conversationId)
    ?.messages[1]
  assert.ok(message?.role === "assistant")
  assert.equal(message.content, "Complete reply")
  assert.equal(message.status, "completed")
  assert.equal(message.finishReason, "stop")
  assert.match(response.body, /event: delta/)
  assert.doesNotMatch(response.body, /event: error/)
}

test(
  "cancellation retains partial text as interrupted without a failure event",
  handleInterruptedTask
)
test(
  "a lost done event keeps the persisted completion without a failure event",
  handleLostDoneEvent
)
