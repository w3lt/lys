import { buildChatChunk, chatTestInput } from "./chatFixtures"
import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import type { ChatCompletionChunk } from "openai/resources/index.mjs"
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

test(
  "cancellation retains partial text as interrupted without a failure event",
  handleInterruptedTask
)
