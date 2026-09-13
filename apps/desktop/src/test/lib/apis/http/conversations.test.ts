import { afterEach, describe, expect, it, vi } from "vitest"

import {
  deleteConversation,
  getConversation,
  listConversations,
  updateConversationTitle
} from "@/lib/apis/http/conversations"

import {
  buildConversationSummary,
  buildListPage,
  buildStoredConversation,
  buildUserMessage,
  createConversationNotFoundResponse,
  createJsonResponse,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMP
} from "../../../fixtures/conversations"

const BACKEND_URL = "http://127.0.0.1:12345"

/** Fastify's body for a route that is not registered. */
const UNREGISTERED_ROUTE_BODY = {
  message: "Route GET:/api/v1/conversations/x not found",
  error: "Not Found",
  statusCode: 404
}

/**
 * Replaces `fetch` with a stub answering every call with one response.
 *
 * @param response - Response returned to the adapter.
 * @returns The stub, for inspecting the requests it received.
 */
function stubFetch(response: Response) {
  const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal("fetch", fetchStub)
  return fetchStub
}

/**
 * Reads the URL and init of the only request a stub received.
 *
 * @param fetchStub - Stub installed by {@link stubFetch}.
 * @returns The requested URL and its init.
 */
function readOnlyRequest(fetchStub: ReturnType<typeof stubFetch>) {
  expect(fetchStub).toHaveBeenCalledTimes(1)
  const [url, init] = fetchStub.mock.calls[0]
  return { url: String(url), init: init ?? {} }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("listConversations", () => {
  const page = buildListPage({
    conversations: [
      buildConversationSummary({
        id: FIXTURE_IDS.firstConversation,
        title: "First",
        updatedAt: FIXTURE_TIMESTAMP,
        preview: { role: "user", content: "hello world" }
      })
    ],
    storedCount: 3,
    matchCount: 1,
    nextCursor: "cursor-2"
  })

  it("sends only the present parameters and returns the validated page", async () => {
    const fetchStub = stubFetch(createJsonResponse(page, 200))

    const result = await listConversations(
      { query: "hello world", limit: 30 },
      { backendUrl: BACKEND_URL }
    )

    const { url, init } = readOnlyRequest(fetchStub)
    expect(url).toBe(
      `${BACKEND_URL}/api/v1/conversations?query=hello+world&limit=30`
    )
    expect(init.method).toBe("GET")
    expect(init.headers).toEqual({ Accept: "application/json" })
    expect(result).toEqual(page)
  })

  it("omits the query string entirely when no parameter is present", async () => {
    const fetchStub = stubFetch(createJsonResponse(page, 200))

    await listConversations({}, { backendUrl: BACKEND_URL })

    expect(readOnlyRequest(fetchStub).url).toBe(
      `${BACKEND_URL}/api/v1/conversations`
    )
  })

  it("rejects a blank search before sending a request", async () => {
    const fetchStub = stubFetch(createJsonResponse(page, 200))

    await expect(
      listConversations({ query: "   " }, { backendUrl: BACKEND_URL })
    ).rejects.toThrow()
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it("rejects a page that lists one conversation twice", async () => {
    const duplicated = buildListPage({
      conversations: [page.conversations[0], page.conversations[0]],
      storedCount: 2,
      matchCount: 2,
      nextCursor: null
    })
    stubFetch(createJsonResponse(duplicated, 200))

    await expect(
      listConversations({}, { backendUrl: BACKEND_URL })
    ).rejects.toThrow("The backend listed a conversation more than once.")
  })

  it("rejects a page whose counts cannot bound its entries", async () => {
    stubFetch(createJsonResponse({ ...page, matchCount: 0 }, 200))

    await expect(
      listConversations({}, { backendUrl: BACKEND_URL })
    ).rejects.toMatchObject({
      message: "The backend returned an invalid conversation response.",
      cause: expect.any(Error)
    })
  })

  it("names only the status of a failed response", async () => {
    stubFetch(createJsonResponse({ message: "internal detail" }, 500))

    await expect(
      listConversations({}, { backendUrl: BACKEND_URL })
    ).rejects.toThrow(
      "The backend could not complete the conversation request (HTTP 500)."
    )
  })
})

describe("getConversation", () => {
  const conversation = buildStoredConversation(FIXTURE_IDS.firstConversation, [
    buildUserMessage(FIXTURE_IDS.userMessage, "hello")
  ])

  it("returns the stored conversation read from its encoded path", async () => {
    const fetchStub = stubFetch(createJsonResponse(conversation, 200))

    const result = await getConversation(FIXTURE_IDS.firstConversation, {
      backendUrl: BACKEND_URL
    })

    expect(readOnlyRequest(fetchStub).url).toBe(
      `${BACKEND_URL}/api/v1/conversations/${FIXTURE_IDS.firstConversation}`
    )
    expect(result).toEqual({ status: "found", conversation })
  })

  it("reports absence only for the declared missing-conversation problem", async () => {
    stubFetch(createConversationNotFoundResponse())

    await expect(
      getConversation(FIXTURE_IDS.firstConversation, {
        backendUrl: BACKEND_URL
      })
    ).resolves.toEqual({ status: "not-found" })
  })

  it("treats a 404 from an unregistered route as a failure, not absence", async () => {
    stubFetch(createJsonResponse(UNREGISTERED_ROUTE_BODY, 404))

    await expect(
      getConversation(FIXTURE_IDS.firstConversation, {
        backendUrl: BACKEND_URL
      })
    ).rejects.toThrow("(HTTP 404)")
  })

  it("rejects a response for a different conversation", async () => {
    stubFetch(
      createJsonResponse(
        buildStoredConversation(FIXTURE_IDS.secondConversation, []),
        200
      )
    )

    await expect(
      getConversation(FIXTURE_IDS.firstConversation, {
        backendUrl: BACKEND_URL
      })
    ).rejects.toThrow("The backend returned a different conversation.")
  })

  it("rejects a malformed identifier before sending a request", async () => {
    const fetchStub = stubFetch(createJsonResponse(conversation, 200))

    await expect(
      getConversation("not-a-uuid", { backendUrl: BACKEND_URL })
    ).rejects.toThrow()
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it("reports an unreachable backend with the transport failure as cause", async () => {
    const transportFailure = new TypeError("Failed to fetch")
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(transportFailure)
    )

    await expect(
      getConversation(FIXTURE_IDS.firstConversation, {
        backendUrl: BACKEND_URL
      })
    ).rejects.toMatchObject({
      message: "The backend could not be reached.",
      cause: transportFailure
    })
  })

  it("propagates the original failure once its signal is aborted", async () => {
    const controller = new AbortController()
    const abortFailure = new DOMException("Aborted", "AbortError")
    controller.abort()
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(abortFailure)
    )

    await expect(
      getConversation(FIXTURE_IDS.firstConversation, {
        backendUrl: BACKEND_URL,
        signal: controller.signal
      })
    ).rejects.toBe(abortFailure)
  })
})

describe("updateConversationTitle", () => {
  const metadata = {
    id: FIXTURE_IDS.firstConversation,
    title: "Renamed",
    systemPrompt: "You are Lys.",
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP
  }

  it("sends the trimmed title as a JSON body and returns the metadata", async () => {
    const fetchStub = stubFetch(createJsonResponse(metadata, 200))

    const result = await updateConversationTitle(
      { conversationId: FIXTURE_IDS.firstConversation, title: "  Renamed  " },
      { backendUrl: BACKEND_URL }
    )

    const { init } = readOnlyRequest(fetchStub)
    expect(init.method).toBe("PATCH")
    expect(init.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json"
    })
    expect(init.body).toBe(JSON.stringify({ title: "Renamed" }))
    expect(result).toEqual({ status: "updated", conversation: metadata })
  })

  it("rejects a blank title before sending a request", async () => {
    const fetchStub = stubFetch(createJsonResponse(metadata, 200))

    await expect(
      updateConversationTitle(
        { conversationId: FIXTURE_IDS.firstConversation, title: "   " },
        { backendUrl: BACKEND_URL }
      )
    ).rejects.toThrow()
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it("reports absence for the declared missing-conversation problem", async () => {
    stubFetch(createConversationNotFoundResponse())

    await expect(
      updateConversationTitle(
        { conversationId: FIXTURE_IDS.firstConversation, title: "Renamed" },
        { backendUrl: BACKEND_URL }
      )
    ).resolves.toEqual({ status: "not-found" })
  })
})

describe("deleteConversation", () => {
  it("sends a bodyless DELETE and reports deletion on 204", async () => {
    const fetchStub = stubFetch(new Response(null, { status: 204 }))

    const result = await deleteConversation(FIXTURE_IDS.firstConversation, {
      backendUrl: BACKEND_URL
    })

    const { init } = readOnlyRequest(fetchStub)
    expect(init.method).toBe("DELETE")
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({ Accept: "application/json" })
    expect(result).toEqual({ status: "deleted" })
  })

  it("reports absence for the declared missing-conversation problem", async () => {
    stubFetch(createConversationNotFoundResponse())

    await expect(
      deleteConversation(FIXTURE_IDS.firstConversation, {
        backendUrl: BACKEND_URL
      })
    ).resolves.toEqual({ status: "not-found" })
  })

  it("rejects a success status other than 204", async () => {
    stubFetch(createJsonResponse({}, 200))

    await expect(
      deleteConversation(FIXTURE_IDS.firstConversation, {
        backendUrl: BACKEND_URL
      })
    ).rejects.toThrow("The backend returned an unexpected delete response.")
  })
})
