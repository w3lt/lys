import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { validatorCompiler } from "fastify-type-provider-zod"
import {
  getConversationApi,
  listConversationsApi,
  updateConversationTitleApi,
  conversationNotFoundProblemSchema
} from "@lys/protocol"
import updateFastifyWithConversationRoutes from "../modules/conversation"
import SqliteConversationStore from "../di/services/conversationService"

/** Verifies the serialized history lifecycle through registered HTTP routes. */
async function handleHistoryRoutes(): Promise<void> {
  using store = SqliteConversationStore.open(":memory:")
  await using app = Fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.decorate("conversationService", store)
  await app.register(updateFastifyWithConversationRoutes)
  const turn = store.createTurnAccess().createConversationTurn({
    model: "test-model",
    userMessageContent: "Earlier prompt"
  })
  const path = `/api/v1/conversations/${turn.conversation.id}`
  const list = await app.inject({ method: "GET", url: "/api/v1/conversations" })
  assert.equal(list.statusCode, 200)
  assert.match(String(list.headers["content-type"]), /application\/json/)
  assert.equal(listConversationsApi.response.parse(list.json()).storedCount, 1)
  const get = await app.inject({ method: "GET", url: path })
  assert.equal(get.statusCode, 200)
  const conversation = getConversationApi.response.parse(get.json())
  assert.equal(conversation.messages[0]?.content, "Earlier prompt")
  const rename = await app.inject({
    method: "PATCH",
    url: path,
    payload: { title: " Renamed " }
  })
  assert.equal(rename.statusCode, 200)
  const metadata = updateConversationTitleApi.response.parse(rename.json())
  assert.equal(metadata.title, "Renamed")
  assert.equal(metadata.updatedAt, conversation.updatedAt)
  const deleted = await app.inject({ method: "DELETE", url: path })
  assert.equal(deleted.statusCode, 204)
  assert.equal(deleted.body, "")
  const missing = await app.inject({ method: "GET", url: path })
  assert.equal(missing.statusCode, 404)
  assert.match(
    String(missing.headers["content-type"]),
    /application\/problem\+json/
  )
  conversationNotFoundProblemSchema.parse(missing.json())
}

test(
  "history routes serialize list, transcript, rename, delete and missing outcomes",
  handleHistoryRoutes
)
