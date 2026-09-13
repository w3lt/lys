import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { conversationNotFoundProblemSchema } from "@lys/protocol"
import { createChatTestApp } from "./chatTestApp"
import { parseConversationListOptions } from "../di/services/conversationService/utils"

/**
 * Verifies a malformed history request is rejected before any mutation.
 * @param context - Test owner of isolated resources.
 * @param request - Untrusted request passed through the real HTTP validator.
 */
async function handleInvalidRequest(
  context: TestContext,
  request: {
    method: "GET" | "PATCH" | "DELETE"
    url: string
    payload?: { title: string }
  }
): Promise<void> {
  const { app, store } = await createChatTestApp(context)
  store
    .createTurnAccess()
    .createConversationTurn({ model: "test", userMessageContent: "Keep me" })
  const history = store.createHistoryAccess()
  const before = history.listConversations(parseConversationListOptions())
  const response = await app.inject(request)
  assert.equal(response.statusCode, 400)
  assert.deepEqual(
    history.listConversations(parseConversationListOptions()),
    before
  )
}

/**
 * Verifies every conversation operation uses the exact typed absence response.
 * @param context - Test owner of isolated resources.
 * @param method - Read, rename, or delete operation for an unknown valid identity.
 */
async function handleMissingRequest(
  context: TestContext,
  method: "GET" | "PATCH" | "DELETE"
): Promise<void> {
  const { app } = await createChatTestApp(context)
  const url = "/api/v1/conversations/0198f5a5-7b9b-7e0b-9b0f-87d9d6a5f72d"
  const request =
    method === "PATCH"
      ? { method, url, payload: { title: "New title" } }
      : { method, url }
  const response = await app.inject(request)
  assert.equal(response.statusCode, 404)
  assert.match(
    String(response.headers["content-type"]),
    /application\/problem\+json/
  )
  assert.equal(
    conversationNotFoundProblemSchema.parse(response.json()).instance,
    url
  )
}

for (const query of [
  "query=",
  "query=%20",
  "query=" + "q".repeat(201),
  "limit=0",
  "limit=51",
  "limit=1.5",
  "cursor=",
  "cursor=garbage",
  "extra=true",
  "limit=1&limit=2"
]) {
  test(`list rejects invalid query ${query.slice(0, 32)}`, (context) =>
    handleInvalidRequest(context, {
      method: "GET",
      url: `/api/v1/conversations?${query}`
    }))
}
for (const method of ["GET", "PATCH", "DELETE"] as const) {
  test(`${method} rejects malformed conversation identity`, (context) =>
    handleInvalidRequest(context, {
      method,
      url: "/api/v1/conversations/not-an-id",
      payload: { title: "Rename" }
    }))
  test(`${method} maps valid missing identity to shared problem`, (context) =>
    handleMissingRequest(context, method))
}
for (const title of ["", " ", "t".repeat(121)]) {
  test(`rename rejects invalid title length ${title.length}`, (context) =>
    handleInvalidRequest(context, {
      method: "PATCH",
      url: "/api/v1/conversations/0198f5a5-7b9b-7e0b-9b0f-87d9d6a5f72d",
      payload: { title }
    }))
}
