import assert from "node:assert/strict"
import { test } from "node:test"
import SqliteConversationStore from ".."
import type SqliteConversationTurns from "../turns"
import { parseConversationListOptions } from "../utils"
import { buildChatMessages } from "../../../../modules/chat/chat/messages"

/** Verifies text, state, and strict role projection survive a transcript read. */
function handlePersistedTurn(): void {
  using store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  const turn = turns.createConversationTurn({
    model: "test",
    userMessageContent: "Prompt"
  })
  assert.equal(
    turns.updateAssistantMessageContent(turn.assistantMessage.id, "Hello "),
    true
  )
  assert.equal(
    turns.updateAssistantMessageContent(turn.assistantMessage.id, "world"),
    true
  )
  assert.equal(
    turns.updateAssistantMessageState(turn.assistantMessage.id, {
      status: "completed",
      finishReason: "stop"
    }),
    true
  )
  assert.equal(
    turns.updateAssistantMessageContent(turn.assistantMessage.id, "late"),
    false
  )
  assert.equal(
    turns.updateAssistantMessageState(turn.assistantMessage.id, {
      status: "failed"
    }),
    false
  )
  const conversation = store
    .createHistoryAccess()
    .getConversation(turn.conversation.id)
  assert.equal(conversation?.messages.length, 2)
  assert.deepEqual(conversation?.messages[0], turn.userMessage)
  const assistant = conversation?.messages[1]
  assert.equal(assistant?.role, "assistant")
  assert.equal(assistant?.content, "Hello world")
  assert.ok(assistant?.role === "assistant")
  assert.equal(assistant.status, "completed")
  assert.equal(assistant.finishReason, "stop")
}

/** Verifies failed pair creation does not retain metadata or a lone user message. */
function handleAtomicTurn(): void {
  using store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  const history = store.createHistoryAccess()
  assert.throws(
    () =>
      turns.createConversationTurn({ model: "", userMessageContent: "Prompt" }),
    { name: "ZodError" }
  )
  assert.equal(
    history.listConversations(parseConversationListOptions()).storedCount,
    0
  )
  const first = turns.createConversationTurn({
    model: "test",
    userMessageContent: "First"
  })
  assert.throws(
    () =>
      turns.createConversationTurn({
        conversationId: first.conversation.id,
        model: "",
        userMessageContent: "Invalid"
      }),
    { name: "ZodError" }
  )
  assert.equal(
    history.getConversation(first.conversation.id)?.messages.length,
    2
  )
}

/** Verifies deleted rows cannot be recreated by delayed generation writes. */
function handleLateWrites(): void {
  using store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  const history = store.createHistoryAccess()
  const turn = turns.createConversationTurn({
    model: "test",
    userMessageContent: "Prompt"
  })
  history.updateConversationTitle(turn.conversation.id, "Manual title")
  assert.equal(
    turns.updateGeneratedConversationTitle(turn.conversation.id, "Late title"),
    undefined
  )
  assert.equal(
    history.getConversation(turn.conversation.id)?.title,
    "Manual title"
  )
  assert.equal(history.deleteConversation(turn.conversation.id), true)
  assert.equal(
    turns.updateAssistantMessageContent(turn.assistantMessage.id, "Late text"),
    false
  )
  assert.equal(
    turns.updateAssistantMessageState(turn.assistantMessage.id, {
      status: "completed",
      finishReason: "stop"
    }),
    false
  )
  assert.equal(
    turns.updateGeneratedConversationTitle(turn.conversation.id, "Later title"),
    undefined
  )
  assert.equal(history.deleteConversation(turn.conversation.id), false)
  assert.equal(history.getConversation(turn.conversation.id), undefined)
}

/** Verifies retained borrowers and newly requested access reject after disposal. */
function handleClosedStore(): void {
  const store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  const history = store.createHistoryAccess()
  store[Symbol.dispose]()
  store[Symbol.dispose]()
  assert.throws(
    () => store.createHistoryAccess(),
    /Conversation store is closed/
  )
  assert.throws(
    () =>
      turns.createConversationTurn({
        model: "test",
        userMessageContent: "Late"
      }),
    /Conversation store is closed/
  )
  assert.throws(
    () => history.listConversations(parseConversationListOptions()),
    /Conversation store is closed/
  )
}

/** Verifies continuation excludes failed, empty, and still-streaming assistant context. */
function handleContinuationContext(): void {
  using store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  const conversationId = createContextFixture(turns)
  const current = turns.createConversationTurn({
    conversationId,
    model: "test",
    userMessageContent: "Continue"
  })
  assert.deepEqual(buildChatMessages(current).slice(1), [
    { role: "user", content: "First" },
    { role: "assistant", content: "Partial reply" },
    { role: "user", content: "Second" },
    { role: "user", content: "Third" },
    { role: "user", content: "Fourth" },
    { role: "user", content: "Continue" }
  ])
}

test(
  "streamed text and terminal state are persisted in a strict transcript",
  handlePersistedTurn
)
test("turn creation is atomic on validation failure", handleAtomicTurn)
test(
  "rename wins title races and deletion rejects late generation writes",
  handleLateWrites
)
test(
  "disposal closes retained borrowers and future acquisitions",
  handleClosedStore
)
test(
  "continuation retains partial interruptions and skips failed or unfinished assistants",
  handleContinuationContext
)

/**
 * Creates prior replies whose terminal states exercise context eligibility.
 * @param turns - Borrowed writes into the scenario's isolated store.
 * @returns The conversation containing interrupted, failed, empty, and pending replies.
 */
function createContextFixture(turns: SqliteConversationTurns): string {
  const first = turns.createConversationTurn({
    model: "test",
    userMessageContent: "First"
  })
  turns.updateAssistantMessageContent(
    first.assistantMessage.id,
    "Partial reply"
  )
  turns.updateAssistantMessageState(first.assistantMessage.id, {
    status: "interrupted"
  })
  const failed = turns.createConversationTurn({
    conversationId: first.conversation.id,
    model: "test",
    userMessageContent: "Second"
  })
  turns.updateAssistantMessageContent(
    failed.assistantMessage.id,
    "Failed reply"
  )
  turns.updateAssistantMessageState(failed.assistantMessage.id, {
    status: "failed"
  })
  const empty = turns.createConversationTurn({
    conversationId: first.conversation.id,
    model: "test",
    userMessageContent: "Third"
  })
  turns.updateAssistantMessageState(empty.assistantMessage.id, {
    status: "interrupted"
  })
  const pending = turns.createConversationTurn({
    conversationId: first.conversation.id,
    model: "test",
    userMessageContent: "Fourth"
  })
  turns.updateAssistantMessageContent(
    pending.assistantMessage.id,
    "Still generating"
  )
  return first.conversation.id
}
