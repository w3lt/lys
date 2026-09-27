import { conversationNotFoundProblemSchema } from "@lys/protocol"
import { describe, expect, it, onTestFinished } from "vitest"
import SqliteConversationStore from "../../../src/di/services/conversationService"
import { updateFastifyWithHttpTransport } from "../../../src/http"
import updateFastifyWithConversationRoutes from "../../../src/modules/conversation"
import { createConversationListCursor } from "../../../src/di/services/conversationService/utils"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"
import { createTestFastify } from "../../support/fastifyTestApp"

/** Identity that no case stores. */
const MISSING_CONVERSATION_ID = createFixtureUuidV7(404)

/**
 * Creates an application with validation, an in-memory store, and the
 * conversation routes registered.
 *
 * @returns The application, captured logs, and store.
 */
async function createConversationRouteApp() {
  const testFastify = createTestFastify()
  const store = SqliteConversationStore.open(":memory:")
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate("conversationService", store)
  await updateFastifyWithConversationRoutes(testFastify.app)
  return { ...testFastify, store }
}

/**
 * Stores one untitled conversation with a single user message.
 *
 * @param store - Store decorated on the application.
 * @param message - User message content.
 * @returns The stored conversation identity.
 */
function storeConversation(
  store: SqliteConversationStore,
  message: string
): string {
  return store.createTurnAccess().createConversationTurn({
    userMessageContent: message,
    model: "qwen/qwen3-8b",
    systemPrompt: "You are Lys."
  }).conversation.id
}

describe("updateFastifyWithConversationRoutes", () => {
  describe("GET /api/v1/conversations", () => {
    it("responds with a page of stored conversations", async () => {
      const { app, store } = await createConversationRouteApp()
      const conversationId = storeConversation(store, "Plan my trip")

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations"
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        conversations: [
          {
            id: conversationId,
            title: null,
            preview: { role: "user", content: "Plan my trip" }
          }
        ],
        storedCount: 1,
        matchCount: 1,
        nextCursor: null
      })
      expect(response.body).not.toContain("You are Lys.")
    })

    it("applies the search query and page size", async () => {
      const { app, store } = await createConversationRouteApp()
      storeConversation(store, "Plan my trip")
      storeConversation(store, "Trip budget")
      storeConversation(store, "Groceries")

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query: { query: "trip", limit: "1" }
      })

      const page = response.json()
      expect(page).toMatchObject({ storedCount: 3, matchCount: 2 })
      expect(page.conversations).toHaveLength(1)
      expect(page.nextCursor).toEqual(expect.any(String))
    })

    it.each([
      ["an empty search query", { query: "  " }],
      ["a page size above the maximum", { limit: "51" }],
      ["an unknown parameter", { sort: "title" }]
    ])("rejects %s", async (_label, query) => {
      const { app } = await createConversationRouteApp()

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query
      })

      expect(response.statusCode).toBe(400)
    })

    it("rejects a cursor issued for another query as invalid input", async () => {
      const { app } = await createConversationRouteApp()
      const cursor = createConversationListCursor("budget", {
        id: createFixtureUuidV7(1),
        title: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        preview: null
      })

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query: { query: "trip", cursor }
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({
        message: "Invalid conversation list query or cursor"
      })
    })
  })

  describe("GET /api/v1/conversations/:conversationId", () => {
    it("responds with the stored conversation and transcript", async () => {
      const { app, store } = await createConversationRouteApp()
      const conversationId = storeConversation(store, "Plan my trip")

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}`
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(
        store.createHistoryAccess().getConversation(conversationId)
      )
    })

    it("responds with the missing-conversation problem", async () => {
      const { app } = await createConversationRouteApp()
      const url = `/api/v1/conversations/${MISSING_CONVERSATION_ID}`

      const response = await app.inject({ method: "GET", url })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(
        conversationNotFoundProblemSchema.parse(response.json())
      ).toMatchObject({
        detail: `Conversation ${MISSING_CONVERSATION_ID} was not found.`,
        instance: url
      })
    })

    it("rejects an identifier that is not a UUIDv7", async () => {
      const { app } = await createConversationRouteApp()

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations/conversation-1"
      })

      expect(response.statusCode).toBe(400)
    })
  })

  describe("PATCH /api/v1/conversations/:conversationId", () => {
    it("stores the trimmed title and responds with the metadata", async () => {
      const { app, store } = await createConversationRouteApp()
      const conversationId = storeConversation(store, "Plan my trip")

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${conversationId}`,
        payload: { title: "  Trip plan  " }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        id: conversationId,
        title: "Trip plan",
        systemPrompt: "You are Lys."
      })
      expect(
        store.createHistoryAccess().getConversation(conversationId)?.title
      ).toBe("Trip plan")
    })

    it("responds with the missing-conversation problem", async () => {
      const { app } = await createConversationRouteApp()

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${MISSING_CONVERSATION_ID}`,
        payload: { title: "Trip plan" }
      })

      expect(response.statusCode).toBe(404)
      expect(
        conversationNotFoundProblemSchema.safeParse(response.json()).success
      ).toBe(true)
    })

    it("rejects a blank title without changing the conversation", async () => {
      const { app, store } = await createConversationRouteApp()
      const conversationId = storeConversation(store, "Plan my trip")

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${conversationId}`,
        payload: { title: "   " }
      })

      expect(response.statusCode).toBe(400)
      expect(
        store.createHistoryAccess().getConversation(conversationId)?.title
      ).toBeNull()
    })
  })

  describe("DELETE /api/v1/conversations/:conversationId", () => {
    it("deletes the conversation and responds without a body", async () => {
      const { app, store } = await createConversationRouteApp()
      const conversationId = storeConversation(store, "Plan my trip")

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${conversationId}`
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(
        store.createHistoryAccess().getConversation(conversationId)
      ).toBeUndefined()
    })

    it("responds with the missing-conversation problem", async () => {
      const { app } = await createConversationRouteApp()

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${MISSING_CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(404)
      expect(
        conversationNotFoundProblemSchema.safeParse(response.json()).success
      ).toBe(true)
    })
  })

  it("fails registration when the conversation store is already closed", async () => {
    const testFastify = createTestFastify()
    const store = SqliteConversationStore.open(":memory:")
    store[Symbol.dispose]()
    testFastify.app.decorate("conversationService", store)

    await expect(
      updateFastifyWithConversationRoutes(testFastify.app)
    ).rejects.toThrow("Conversation store is closed")
  })
})
