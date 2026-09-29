import {
  conversationNotFoundProblemSchema,
  type ListConversationsApiResponse
} from "@lys/protocol"
import type { Conversation, ConversationMetadata } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import SqliteConversationStore from "../../../../src/di/services/conversationService"
import { createConversationListCursor } from "../../../../src/di/services/conversationService/utils"
import { updateFastifyWithHttpTransport } from "../../../../src/http"
import updateFastifyWithConversationRoutes from "../../../../src/modules/conversation"
import {
  createAssistantMessage,
  createFixtureUuidV7,
  createUserMessage,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"
import { createTestFastify } from "../../support/fastifyTestApp"

/** Identity of the conversation the stubbed history answers for. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Identity that the stubbed history reports as absent. */
const MISSING_CONVERSATION_ID = createFixtureUuidV7(404)

/** Metadata of {@link CONVERSATION_ID} returned by the stubbed history. */
const CONVERSATION_METADATA = Object.freeze({
  id: CONVERSATION_ID,
  title: "Trip plan",
  systemPrompt: "You are Lys.",
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP
} satisfies ConversationMetadata)

/** Complete transcript of {@link CONVERSATION_ID} returned by the stubbed history. */
const CONVERSATION = Object.freeze({
  ...CONVERSATION_METADATA,
  messages: [
    createUserMessage(2, "Plan my trip"),
    createAssistantMessage(3, "Here is a plan", {
      status: "completed",
      finishReason: "stop"
    })
  ]
} satisfies Conversation)

/** One-conversation page returned by the stubbed history. */
const CONVERSATION_PAGE = Object.freeze({
  conversations: [
    {
      id: CONVERSATION_ID,
      title: "Trip plan",
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      preview: { role: "assistant", content: "Here is a plan" }
    }
  ],
  storedCount: 3,
  matchCount: 1,
  nextCursor: null
} satisfies ListConversationsApiResponse)

/**
 * Fails a history call that the current case did not arrange.
 *
 * @param operationName - History operation that was called.
 * @throws Always.
 */
function rejectUnexpectedHistoryCall(operationName: string): never {
  throw new Error(`Unexpected conversation history call: ${operationName}`)
}

/**
 * Creates an application with the HTTP transport and the conversation routes
 * registered over a stubbed history access.
 *
 * @returns The application, captured logs, and a spy for each history
 * operation the routes can call.
 * @remarks The routes borrow the history access once at registration, so the
 * returned spies control every outcome. Each spy throws until the case
 * configures it; no database row is read or written. The in-memory store that
 * backs the decoration is disposed when the test finishes.
 */
async function createConversationRouteApp() {
  const testFastify = createTestFastify()
  const store = SqliteConversationStore.open(":memory:")
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  const history = store.createHistoryAccess()
  vi.spyOn(store, "createHistoryAccess").mockReturnValue(history)
  const historyCalls = {
    listConversations: vi
      .spyOn(history, "listConversations")
      .mockImplementation(() =>
        rejectUnexpectedHistoryCall("listConversations")
      ),
    getConversation: vi
      .spyOn(history, "getConversation")
      .mockImplementation(() => rejectUnexpectedHistoryCall("getConversation")),
    updateConversationTitle: vi
      .spyOn(history, "updateConversationTitle")
      .mockImplementation(() =>
        rejectUnexpectedHistoryCall("updateConversationTitle")
      ),
    deleteConversation: vi
      .spyOn(history, "deleteConversation")
      .mockImplementation(() =>
        rejectUnexpectedHistoryCall("deleteConversation")
      )
  }
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate("conversationService", store)
  await updateFastifyWithConversationRoutes(testFastify.app)
  return { ...testFastify, historyCalls }
}

describe("updateFastifyWithConversationRoutes", () => {
  describe("GET /api/v1/conversations", () => {
    it("responds with the page read from history", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.listConversations.mockReturnValue(CONVERSATION_PAGE)

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations"
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(CONVERSATION_PAGE)
      expect(historyCalls.listConversations).toHaveBeenCalledOnce()
      expect(historyCalls.listConversations).toHaveBeenCalledWith(
        expect.objectContaining({ query: "", cursor: undefined })
      )
    })

    it("reads the page for the search query and page size", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.listConversations.mockReturnValue(CONVERSATION_PAGE)

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query: { query: "  trip  ", limit: "1" }
      })

      expect(response.statusCode).toBe(200)
      expect(historyCalls.listConversations).toHaveBeenCalledWith({
        query: "trip",
        cursor: undefined,
        limit: 1
      })
    })

    it.each([
      ["an empty search query", { query: "  " }],
      ["a page size above the maximum", { limit: "51" }],
      ["an unknown parameter", { sort: "title" }]
    ])("rejects %s", async (_label, query) => {
      const { app, historyCalls } = await createConversationRouteApp()

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        query
      })

      expect(response.statusCode).toBe(400)
      expect(historyCalls.listConversations).not.toHaveBeenCalled()
    })

    it("rejects a cursor issued for another query as invalid input", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
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
      expect(historyCalls.listConversations).not.toHaveBeenCalled()
    })
  })

  describe("GET /api/v1/conversations/:conversationId", () => {
    it("responds with the conversation and transcript read from history", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversation.mockReturnValue(CONVERSATION)

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(CONVERSATION)
      expect(historyCalls.getConversation).toHaveBeenCalledWith(CONVERSATION_ID)
    })

    it("responds with the missing-conversation problem", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.getConversation.mockReturnValue(undefined)
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
      expect(historyCalls.getConversation).toHaveBeenCalledWith(
        MISSING_CONVERSATION_ID
      )
    })

    it("rejects an identifier that is not a UUIDv7", async () => {
      const { app, historyCalls } = await createConversationRouteApp()

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/conversations/conversation-1"
      })

      expect(response.statusCode).toBe(400)
      expect(historyCalls.getConversation).not.toHaveBeenCalled()
    })
  })

  describe("PATCH /api/v1/conversations/:conversationId", () => {
    it("replaces the title with its trimmed text and responds with the metadata", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.updateConversationTitle.mockReturnValue(
        CONVERSATION_METADATA
      )

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${CONVERSATION_ID}`,
        payload: { title: "  Trip plan  " }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(CONVERSATION_METADATA)
      expect(historyCalls.updateConversationTitle).toHaveBeenCalledWith(
        CONVERSATION_ID,
        "Trip plan"
      )
    })

    it("responds with the missing-conversation problem", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.updateConversationTitle.mockReturnValue(undefined)
      const url = `/api/v1/conversations/${MISSING_CONVERSATION_ID}`

      const response = await app.inject({
        method: "PATCH",
        url,
        payload: { title: "Trip plan" }
      })

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

    it("rejects a blank title without replacing it", async () => {
      const { app, historyCalls } = await createConversationRouteApp()

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${CONVERSATION_ID}`,
        payload: { title: "   " }
      })

      expect(response.statusCode).toBe(400)
      expect(historyCalls.updateConversationTitle).not.toHaveBeenCalled()
    })
  })

  describe("DELETE /api/v1/conversations/:conversationId", () => {
    it("deletes the conversation and responds without a body", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.deleteConversation.mockReturnValue(true)

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/conversations/${CONVERSATION_ID}`
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(historyCalls.deleteConversation).toHaveBeenCalledWith(
        CONVERSATION_ID
      )
    })

    it("responds with the missing-conversation problem", async () => {
      const { app, historyCalls } = await createConversationRouteApp()
      historyCalls.deleteConversation.mockReturnValue(false)
      const url = `/api/v1/conversations/${MISSING_CONVERSATION_ID}`

      const response = await app.inject({ method: "DELETE", url })

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
  })

  it("fails registration when the history access cannot be borrowed", async () => {
    const testFastify = createTestFastify()
    const store = SqliteConversationStore.open(":memory:")
    onTestFinished(() => {
      store[Symbol.dispose]()
    })
    const accessFailure = new Error("history access unavailable")
    vi.spyOn(store, "createHistoryAccess").mockImplementation(() => {
      throw accessFailure
    })
    testFastify.app.decorate("conversationService", store)

    await expect(
      updateFastifyWithConversationRoutes(testFastify.app)
    ).rejects.toBe(accessFailure)
  })
})
