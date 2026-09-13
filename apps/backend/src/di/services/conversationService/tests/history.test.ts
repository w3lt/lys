import assert from "node:assert/strict"
import { test } from "node:test"
import SqliteConversationStore from ".."
import { parseConversationListOptions } from "../utils"

/** Verifies that a rename preserves activity ordering and is repeatable. */
function handleRenamePreservesActivity(): void {
  using store = SqliteConversationStore.open(":memory:")
  const history = store.createHistoryAccess()
  const turn = store
    .createTurnAccess()
    .createConversationTurn({ model: "test", userMessageContent: "Prompt" })
  const before = history.getConversation(turn.conversation.id)
  assert.ok(before)
  const renamed = history.updateConversationTitle(before.id, "  Renamed  ")
  assert.equal(renamed?.title, "Renamed")
  assert.equal(renamed?.updatedAt, before.updatedAt)
  assert.deepEqual(
    history.updateConversationTitle(before.id, "Renamed"),
    renamed
  )
}

/** Verifies literal Unicode substring filtering over stored messages. */
function handleSearchAndPreview(): void {
  using store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  const history = store.createHistoryAccess()
  const turn = turns.createConversationTurn({
    model: "test",
    userMessageContent: "CAFÉ 100%_done [a.b]"
  })
  turns.updateAssistantMessageContent(
    turn.assistantMessage.id,
    "Later unrelated reply"
  )
  turns.createConversationTurn({
    model: "test",
    userMessageContent: "Unrelated"
  })
  const page = history.listConversations(
    parseConversationListOptions({ query: "café 100%_" })
  )
  assert.equal(page.conversations.length, 1)
  assert.equal(page.conversations[0]?.id, turn.conversation.id)
  assert.deepEqual(page.conversations[0]?.preview, {
    role: "user",
    content: "CAFÉ 100%_done [a.b]"
  })
  assert.equal(page.storedCount, 2)
  assert.equal(page.matchCount, 1)
  assert.equal(page.nextCursor, null)
  assert.equal(
    history.listConversations(parseConversationListOptions({ query: "[a.b]" }))
      .matchCount,
    1
  )
  assert.equal(
    history.listConversations(parseConversationListOptions({ query: "a+b" }))
      .matchCount,
    0
  )
}

/** Verifies a title-only hit uses the most recent nonempty message. */
function handleTitlePreview(): void {
  using store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  const history = store.createHistoryAccess()
  const turn = turns.createConversationTurn({
    model: "test",
    userMessageContent: "First"
  })
  turns.updateAssistantMessageContent(
    turn.assistantMessage.id,
    "Latest content"
  )
  history.updateConversationTitle(turn.conversation.id, "Résumé")
  const page = history.listConversations(
    parseConversationListOptions({ query: "RÉSUMÉ" })
  )
  assert.deepEqual(page.conversations[0]?.preview, {
    role: "assistant",
    content: "Latest content"
  })
  assert.deepEqual(
    history.listConversations(parseConversationListOptions()).conversations[0]
      ?.preview,
    page.conversations[0]?.preview
  )
}

/** Verifies default page bounds and a cursor that can outlive its boundary row. */
function handlePagination(): void {
  using store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  const history = store.createHistoryAccess()
  for (let index = 0; index < 32; index += 1)
    turns.createConversationTurn({
      model: "test",
      userMessageContent: `Prompt ${index}`
    })
  const page = history.listConversations(parseConversationListOptions())
  assert.equal(page.conversations.length, 30)
  assert.equal(page.storedCount, 32)
  assert.ok(page.nextCursor)
  const boundary = page.conversations.at(-1)
  assert.ok(boundary)
  history.deleteConversation(boundary.id)
  const next = history.listConversations(
    parseConversationListOptions({ cursor: page.nextCursor })
  )
  assert.equal(next.conversations.length, 2)
  assert.equal(next.storedCount, 31)
  assert.equal(next.nextCursor, null)
  assert.equal(
    new Set([...page.conversations, ...next.conversations].map(({ id }) => id))
      .size,
    32
  )
  assert.equal(
    history.listConversations(parseConversationListOptions({ limit: 50 }))
      .conversations.length,
    31
  )
}

/** Verifies query binding, malformed cursors, and bounded list inputs. */
function handleInvalidPagination(): void {
  using store = SqliteConversationStore.open(":memory:")
  const turns = store.createTurnAccess()
  for (let index = 0; index < 2; index += 1)
    turns.createConversationTurn({ model: "test", userMessageContent: "Same" })
  const page = store
    .createHistoryAccess()
    .listConversations(
      parseConversationListOptions({ query: "Same", limit: 1 })
    )
  assert.ok(page.nextCursor)
  assert.throws(
    () =>
      parseConversationListOptions({
        query: "Different",
        cursor: page.nextCursor ?? ""
      }),
    { statusCode: 400 }
  )
  assert.throws(() => parseConversationListOptions({ cursor: "garbage" }), {
    statusCode: 400
  })
  assert.throws(() => parseConversationListOptions({ cursor: " " }), {
    statusCode: 400
  })
  assert.throws(() => parseConversationListOptions({ query: " " }), {
    statusCode: 400
  })
  assert.throws(
    () => parseConversationListOptions({ query: "q".repeat(201) }),
    { statusCode: 400 }
  )
  assert.throws(() => parseConversationListOptions({ limit: 0 }), {
    statusCode: 400
  })
  assert.throws(() => parseConversationListOptions({ limit: 51 }), {
    statusCode: 400
  })
  assert.throws(() => parseConversationListOptions({ limit: 1.5 }), {
    statusCode: 400
  })
}

test(
  "renaming preserves activity time and is idempotent",
  handleRenamePreservesActivity
)
test(
  "search filters Unicode literal substrings and returns matching previews",
  handleSearchAndPreview
)
test(
  "title-only matches and unfiltered lists use the latest nonempty message",
  handleTitlePreview
)
test(
  "default pagination stays bounded and continues after boundary deletion",
  handlePagination
)
test(
  "pagination rejects malformed input and cross-query cursors",
  handleInvalidPagination
)
