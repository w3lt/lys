import assert from "node:assert/strict"
import { once } from "node:events"
import { DatabaseSync } from "node:sqlite"
import { setImmediate } from "node:timers/promises"
import { test, type TestContext } from "node:test"
import type { CompleteChatOptions } from "../di/services/chatService"
import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import { createChatTestApp } from "./chatTestApp"
import { buildChatChunk, chatTestInput } from "./chatFixtures"
import { parseConversationListOptions } from "../di/services/conversationService/utils"

/**
 * Creates an upstream whose cancellation cleanup waits for a test-owned barrier.
 * @returns Admission and cancellation observations, a release operation, and the stream.
 */
function createDelayedCancellation() {
  const paused = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  /**
   * Delays cancellation settlement after the socket has already closed.
   * @param options - Model input carrying the production disconnect signal.
   * @returns A partial reply followed by controlled cancellation failure.
   */
  async function* createReply({
    signal
  }: CompleteChatOptions): AsyncGenerator<ChatCompletionChunk> {
    yield buildChatChunk("Partial", null)
    paused.resolve()
    assert.ok(signal)
    await once(signal, "abort")
    cancelled.resolve()
    await resume.promise
    throw new Error("Controlled upstream cancellation")
  }
  return {
    paused: paused.promise,
    cancelled: cancelled.promise,
    resume: resume.resolve,
    createReply
  }
}

/**
 * Proves socket closure cannot dispose SQLite before cancelled handlers finalize.
 * @param context - Runner owning the real loopback server and isolated database.
 */
async function handleDisconnectedShutdown(context: TestContext): Promise<void> {
  const { app, store, chatService, databaseFilePath } =
    await createChatTestApp(context)
  const upstream = createDelayedCancellation()
  using cleanup = new DisposableStack()
  cleanup.defer(upstream.resume)
  context.mock.method(chatService, "completeChatStream", upstream.createReply)
  context.mock.method(chatService, "generateTitle", async () => "Title")
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  const controller = new AbortController()
  cleanup.defer(() => controller.abort())
  await fetch(`${address}/api/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify(chatTestInput)
  })
  await upstream.paused
  controller.abort()
  await upstream.cancelled
  const socketClosed = once(app.server, "close")
  let closed = false
  const closing = app.close().then(() => {
    closed = true
  })
  await socketClosed
  await setImmediate()
  assert.equal(closed, false, "shutdown must join disconnected handlers")
  const history = store.createHistoryAccess()
  const conversation = history.listConversations(parseConversationListOptions())
    .conversations[0]
  assert.ok(conversation)
  upstream.resume()
  await closing
  using database = new DatabaseSync(databaseFilePath, { readOnly: true })
  assert.partialDeepStrictEqual(
    database
      .prepare(
        "SELECT status, content FROM conversation_messages WHERE role = 'assistant'"
      )
      .get(),
    { status: "interrupted", content: "Partial" }
  )
  assert.throws(() => history.getConversation(conversation.id), /closed/)
}

/**
 * Keeps terminal storage failures inside the established SSE response boundary.
 * @param context - Runner owner of external model fixtures and isolated storage.
 */
async function handleTerminalPersistenceFailure(
  context: TestContext
): Promise<void> {
  const { app, chatService, databaseFilePath } =
    await createChatTestApp(context)
  /** Supplies a completed model response before terminal persistence fails. */
  async function* createReply(): AsyncGenerator<ChatCompletionChunk> {
    yield buildChatChunk("Reply", "stop")
  }
  using database = new DatabaseSync(databaseFilePath)
  database.exec(`CREATE TRIGGER reject_terminal_update BEFORE UPDATE OF status
    ON conversation_messages WHEN NEW.status <> 'streaming'
    BEGIN SELECT RAISE(FAIL, 'Controlled terminal storage failure'); END`)
  context.mock.method(chatService, "completeChatStream", createReply)
  context.mock.method(chatService, "generateTitle", async () => "Title")
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/chat",
    payload: chatTestInput
  })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers["content-type"] ?? "", /text\/event-stream/)
  assert.match(response.body, /event: delta/)
  assert.doesNotMatch(response.body, /event: done|Internal Server Error/)
}

test(
  "shutdown joins a disconnected chat handler before service disposal",
  { timeout: 5000 },
  handleDisconnectedShutdown
)
test(
  "terminal persistence failure does not write HTTP headers after SSE starts",
  { timeout: 3000 },
  handleTerminalPersistenceFailure
)
