import { buildChatChunk, chatTestInput } from "./chatFixtures"
import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createChatTestApp } from "./chatTestApp"
import { parseConversationListOptions } from "../di/services/conversationService/utils"

/**
 * Verifies a user rename wins against a still-pending title model response.
 * @param context - Runner owner of isolated services, mocks, and cleanup.
 */
async function handleRenameRace(context: TestContext): Promise<void> {
  const { app, store, chatService } = await createChatTestApp(context)
  const title = Promise.withResolvers<string>()
  const titleStarted = Promise.withResolvers<void>()
  using pending = new DisposableStack()
  pending.defer(() => title.resolve("Late generated title"))
  /** Supplies a delayed external title response after signaling model admission. */
  function createTitle(): Promise<string> {
    titleStarted.resolve()
    return title.promise
  }
  /** Completes chat while the independent title model is still pending. */
  async function* createReply() {
    yield buildChatChunk("Reply", "stop")
  }
  context.mock.method(chatService, "completeChatStream", createReply)
  context.mock.method(chatService, "generateTitle", createTitle)
  const response = app.inject({
    method: "POST",
    url: "/api/v1/chat",
    payload: chatTestInput
  })
  await titleStarted.promise
  const conversation = store
    .createHistoryAccess()
    .listConversations(parseConversationListOptions()).conversations[0]
  assert.ok(conversation)
  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/v1/conversations/${conversation.id}`,
    payload: { title: "Manual title" }
  })
  assert.equal(renamed.statusCode, 200)
  title.resolve("Late generated title")
  const stream = await response
  assert.doesNotMatch(stream.body, /event: title/)
  assert.equal(
    store.createHistoryAccess().getConversation(conversation.id)?.title,
    "Manual title"
  )
}

/**
 * Verifies deletion during generation prevents later text, terminal, and title writes.
 * @param context - Runner owner of isolated services, mocks, and cleanup.
 */
async function handleDeleteRace(context: TestContext): Promise<void> {
  const { app, store, chatService } = await createChatTestApp(context)
  const paused = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  using pending = new DisposableStack()
  pending.defer(() => resume.resolve())
  /** Pauses after the first delta has been persisted and published. */
  async function* createReply() {
    yield buildChatChunk("Partial", null)
    paused.resolve()
    await resume.promise
    yield buildChatChunk("Late", "stop")
  }
  /** Defers the external title result until after the DELETE request. */
  async function createTitle(): Promise<string> {
    await resume.promise
    return "Late title"
  }
  context.mock.method(chatService, "completeChatStream", createReply)
  context.mock.method(chatService, "generateTitle", createTitle)
  const response = app.inject({
    method: "POST",
    url: "/api/v1/chat",
    payload: chatTestInput
  })
  await paused.promise
  const history = store.createHistoryAccess()
  const conversation = history.listConversations(parseConversationListOptions())
    .conversations[0]
  assert.ok(conversation)
  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/v1/conversations/${conversation.id}`
  })
  assert.equal(deleted.statusCode, 204)
  resume.resolve()
  const stream = await response
  assert.doesNotMatch(stream.body, /Late|event: title|event: error|event: done/)
  assert.equal(history.getConversation(conversation.id), undefined)
  assert.equal(
    history.listConversations(parseConversationListOptions()).storedCount,
    0
  )
}

test(
  "manual rename wins a delayed title response without a stale title event",
  { timeout: 3000 },
  handleRenameRace
)
test(
  "deleting mid-reply prevents all late writes and events",
  { timeout: 3000 },
  handleDeleteRace
)
