import { describe, expect, it } from "vitest"
import {
  deleteConversation,
  getConversation,
  listConversations,
  updateConversationTitle
} from "@/lib/apis/http/conversations"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute
} from "../../../support/backendFake"
import {
  buildConversation,
  buildConversationListPage,
  buildConversationMetadata,
  buildConversationNotFoundProblem,
  buildConversationSummary,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../../support/conversationFixtures"

/** Backend origin the cases pass; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/** Path of the conversation the single-conversation cases address. */
const CONVERSATION_PATH = `/api/v1/conversations/${FIXTURE_CONVERSATION_ID}`

/** A conversation other than the addressed one. */
const OTHER_CONVERSATION_ID = createFixtureUuidV7(9)

/**
 * Starts a backend that answers the conversation list with one route.
 *
 * @param route - Response to every list request.
 * @returns The backend observation handle.
 */
function startListBackend(route: BackendRoute) {
  return startBackendFake({ "GET /api/v1/conversations": route })
}

describe("listConversations", () => {
  it("requests the first page without a query string and returns it", async () => {
    const page = buildConversationListPage([
      buildConversationSummary(FIXTURE_CONVERSATION_ID, "Trip", {
        role: "user",
        content: "Plan a trip"
      })
    ])
    const backend = startListBackend(() => buildJsonResponse(200, page))
    const signal = new AbortController().signal

    await expect(
      listConversations({}, { backendUrl: BACKEND_URL, signal })
    ).resolves.toEqual(page)
    expect(backend.requests[0]?.url).toBe(`${BACKEND_URL}/api/v1/conversations`)
    expect(backend.requests[0]?.signal).toBe(signal)
    expect(backend.requests[0]?.cache).toBe("no-store")
    expect(backend.requests[0]?.headers.has("Content-Type")).toBe(false)
  })

  it("sends every present list parameter, encoded", async () => {
    const backend = startListBackend(() =>
      buildJsonResponse(200, buildConversationListPage([]))
    )

    await listConversations(
      { query: "café & tea", cursor: "opaque+cursor", limit: 50 },
      { backendUrl: BACKEND_URL }
    )

    const searchParams = new URL(backend.requests[0]?.url ?? "").searchParams
    expect(Object.fromEntries(searchParams)).toEqual({
      query: "café & tea",
      cursor: "opaque+cursor",
      limit: "50"
    })
  })

  it.each([
    ["a whitespace-only search", { query: "   " }],
    ["a page size over the maximum", { limit: 51 }],
    ["an empty cursor", { cursor: "" }]
  ])("rejects %s without contacting the backend", async (_label, query) => {
    const backend = startBackendFake({})

    await expect(
      listConversations(query, { backendUrl: BACKEND_URL })
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })

  it("rejects a page that lists a conversation twice", async () => {
    const summary = buildConversationSummary(FIXTURE_CONVERSATION_ID, "A", null)
    startListBackend(() =>
      buildJsonResponse(200, {
        conversations: [summary, summary],
        storedCount: 2,
        matchCount: 2,
        nextCursor: null
      })
    )

    await expect(
      listConversations({}, { backendUrl: BACKEND_URL })
    ).rejects.toThrow(Error)
  })

  it("rejects a page whose counts cannot bound it", async () => {
    startListBackend(() =>
      buildJsonResponse(200, {
        conversations: [],
        storedCount: 1,
        matchCount: 2,
        nextCursor: null
      })
    )

    await expect(
      listConversations({}, { backendUrl: BACKEND_URL })
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
  })

  it("rejects a valid page sent with a media type other than JSON", async () => {
    startListBackend(() =>
      buildJsonResponse(200, buildConversationListPage([]), "text/plain")
    )

    await expect(
      listConversations({}, { backendUrl: BACKEND_URL })
    ).rejects.toThrow(Error)
  })

  it("rejects a failed status, naming only the status", async () => {
    startListBackend(() =>
      buildJsonResponse(500, { detail: "SQLITE_BUSY at /Users/secret" })
    )

    const page = listConversations({}, { backendUrl: BACKEND_URL })

    await expect(page).rejects.toThrow("500")
    await expect(page).rejects.not.toThrow("/Users/secret")
  })

  it("rejects an unreachable backend and keeps the transport failure as its cause", async () => {
    const transportFailure = new TypeError("fetch failed")
    startListBackend(() => Promise.reject(transportFailure))

    await expect(
      listConversations({}, { backendUrl: BACKEND_URL })
    ).rejects.toMatchObject({ cause: transportFailure })
  })

  it("rejects with the original abort failure when the caller cancels", async () => {
    startListBackend(() => new Promise<Response>(() => {}))
    const controller = new AbortController()

    const page = listConversations(
      {},
      { backendUrl: BACKEND_URL, signal: controller.signal }
    )
    controller.abort()

    await expect(page).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("getConversation", () => {
  it("returns the stored conversation", async () => {
    const conversation = buildConversation(FIXTURE_CONVERSATION_ID, "Trip", [
      buildUserMessage(2, "Plan a trip")
    ])
    const backend = startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () => buildJsonResponse(200, conversation)
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, { backendUrl: BACKEND_URL })
    ).resolves.toEqual({ status: "found", conversation })
    expect(backend.requests[0]?.url).toBe(`${BACKEND_URL}${CONVERSATION_PATH}`)
  })

  it("reports the declared missing conversation as not found", async () => {
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(404, buildConversationNotFoundProblem())
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, { backendUrl: BACKEND_URL })
    ).resolves.toEqual({ status: "not-found" })
  })

  it("rejects an undeclared 404 instead of reporting the conversation absent", async () => {
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(404, { message: "Route not found" })
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, { backendUrl: BACKEND_URL })
    ).rejects.toThrow("404")
  })

  it("rejects a different conversation than the one requested", async () => {
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(
          200,
          buildConversation(OTHER_CONVERSATION_ID, null, [])
        )
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, { backendUrl: BACKEND_URL })
    ).rejects.toThrow(Error)
  })

  it("rejects a malformed conversation and keeps the decoding failure as its cause", async () => {
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(200, { id: FIXTURE_CONVERSATION_ID })
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, { backendUrl: BACKEND_URL })
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
  })

  it("rejects an identifier that is not a UUIDv7 without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      getConversation("../agents", { backendUrl: BACKEND_URL })
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })
})

describe("updateConversationTitle", () => {
  it("sends the trimmed title and returns the stored metadata", async () => {
    const metadata = buildConversationMetadata(FIXTURE_CONVERSATION_ID, "Trip")
    const backend = startBackendFake({
      [`PATCH ${CONVERSATION_PATH}`]: () => buildJsonResponse(200, metadata)
    })

    await expect(
      updateConversationTitle(
        { conversationId: FIXTURE_CONVERSATION_ID, title: "  Trip  " },
        { backendUrl: BACKEND_URL }
      )
    ).resolves.toEqual({ status: "updated", conversation: metadata })
    expect(backend.requests[0]?.body).toEqual({ title: "Trip" })
    expect(backend.requests[0]?.headers.get("Content-Type")).toBe(
      "application/json"
    )
  })

  it.each([
    ["an empty title", "   "],
    ["a title over 120 characters", "t".repeat(121)]
  ])("rejects %s without contacting the backend", async (_label, title) => {
    const backend = startBackendFake({})

    await expect(
      updateConversationTitle(
        { conversationId: FIXTURE_CONVERSATION_ID, title },
        { backendUrl: BACKEND_URL }
      )
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })

  it("reports the declared missing conversation as not found", async () => {
    startBackendFake({
      [`PATCH ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(404, buildConversationNotFoundProblem())
    })

    await expect(
      updateConversationTitle(
        { conversationId: FIXTURE_CONVERSATION_ID, title: "Trip" },
        { backendUrl: BACKEND_URL }
      )
    ).resolves.toEqual({ status: "not-found" })
  })

  it("rejects metadata for a different conversation", async () => {
    startBackendFake({
      [`PATCH ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(
          200,
          buildConversationMetadata(OTHER_CONVERSATION_ID, "Trip")
        )
    })

    await expect(
      updateConversationTitle(
        { conversationId: FIXTURE_CONVERSATION_ID, title: "Trip" },
        { backendUrl: BACKEND_URL }
      )
    ).rejects.toThrow(Error)
  })
})

describe("deleteConversation", () => {
  it("reports the deletion the backend acknowledges", async () => {
    const backend = startBackendFake({
      [`DELETE ${CONVERSATION_PATH}`]: () => new Response(null, { status: 204 })
    })

    await expect(
      deleteConversation(FIXTURE_CONVERSATION_ID, { backendUrl: BACKEND_URL })
    ).resolves.toEqual({ status: "deleted" })
    expect(backend.requests[0]?.body).toBeUndefined()
  })

  it("reports the declared missing conversation as not found", async () => {
    startBackendFake({
      [`DELETE ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(404, buildConversationNotFoundProblem())
    })

    await expect(
      deleteConversation(FIXTURE_CONVERSATION_ID, { backendUrl: BACKEND_URL })
    ).resolves.toEqual({ status: "not-found" })
  })

  it.each([
    ["an unexpected success status", 200],
    ["a server failure", 500]
  ])("rejects %s", async (_label, status) => {
    startBackendFake({
      [`DELETE ${CONVERSATION_PATH}`]: () => buildJsonResponse(status, {})
    })

    await expect(
      deleteConversation(FIXTURE_CONVERSATION_ID, { backendUrl: BACKEND_URL })
    ).rejects.toThrow(Error)
  })
})
