import { describe, expect, it } from "vitest"
import {
  deleteConversation,
  getConversation,
  listConversations,
  updateConversationTitle
} from "@/lib/apis/http/conversations"
import { JOB_CONVERSATION_MESSAGE } from "@/lib/job-messages"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  startBackendFake,
  type BackendRoute
} from "../../../support/backendFake"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildConversationIsJobProblem,
  buildConversationListPage,
  buildConversationMetadata,
  buildConversationNotFoundProblem,
  buildConversationSummary,
  buildConversationWithJobs,
  buildDelegatorMessage,
  buildJob,
  buildJobConversation,
  buildJobReport,
  buildUserMessage,
  buildUserMessageWithReports,
  buildWakeUpMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID,
  FIXTURE_JOB_ID
} from "../../../support/conversationFixtures"

/** Path of the conversation the single-conversation cases address. */
const CONVERSATION_PATH = `/api/v1/conversations/${FIXTURE_CONVERSATION_ID}`

/** Path of the job the job cases address. */
const JOB_PATH = `/api/v1/conversations/${FIXTURE_JOB_ID}`

/** A conversation other than the addressed one. */
const OTHER_CONVERSATION_ID = createFixtureUuidV7(9)

/**
 * A job's parent, number, and delegator given only in part: each row sets
 * some of the three and leaves the others null, which neither a main
 * conversation nor a job allows.
 */
const PARTIAL_JOB_FIELDS = [
  ["a parent alone", { parentConversationId: FIXTURE_CONVERSATION_ID }],
  ["a job number alone", { jobNumber: 1 }],
  ["a delegator alone", { delegatorAgentCode: "caliginia" }],
  [
    "a parent and a job number without a delegator",
    { parentConversationId: FIXTURE_CONVERSATION_ID, jobNumber: 1 }
  ],
  [
    "a parent and a delegator without a job number",
    {
      parentConversationId: FIXTURE_CONVERSATION_ID,
      delegatorAgentCode: "caliginia"
    }
  ],
  [
    "a job number and a delegator without a parent",
    { jobNumber: 1, delegatorAgentCode: "caliginia" }
  ]
] as const

/**
 * A kind that names the other variant: each row gives the fields of one
 * variant under the kind of the other, which neither variant allows.
 */
const MISMATCHED_KIND_FIELDS = [
  ["a main conversation's fields under the job kind", { kind: "job" }],
  [
    "a job's fields under the main kind",
    {
      kind: "main",
      parentConversationId: FIXTURE_CONVERSATION_ID,
      jobNumber: 1,
      delegatorAgentCode: "caliginia"
    }
  ]
] as const

/**
 * Builds the body of a conversation whose one message delivered a report, as
 * a backend could send it, without validating the report.
 *
 * @param report - The report the message delivered, valid or not.
 * @returns The untrusted body of {@link FIXTURE_CONVERSATION_ID}.
 */
function buildConversationBodyWithReport(report: object): object {
  const message = buildUserMessage(2, "Any news yet?")
  return {
    ...buildConversation(FIXTURE_CONVERSATION_ID, "Trip", []),
    messages: [{ ...message, reports: [report] }]
  }
}

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
      listConversations({}, { backendUrl: FIXTURE_BACKEND_URL, signal })
    ).resolves.toEqual(page)
    expect(backend.requests[0]?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/conversations`
    )
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
      { backendUrl: FIXTURE_BACKEND_URL }
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
      listConversations(query, { backendUrl: FIXTURE_BACKEND_URL })
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
      listConversations({}, { backendUrl: FIXTURE_BACKEND_URL })
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
      listConversations({}, { backendUrl: FIXTURE_BACKEND_URL })
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
  })

  it("rejects a valid page sent with a media type other than JSON", async () => {
    startListBackend(() =>
      buildJsonResponse(200, buildConversationListPage([]), "text/plain")
    )

    await expect(
      listConversations({}, { backendUrl: FIXTURE_BACKEND_URL })
    ).rejects.toThrow(Error)
  })

  it("rejects a failed status, naming only the status", async () => {
    startListBackend(() =>
      buildJsonResponse(500, { detail: "SQLITE_BUSY at /Users/secret" })
    )

    const page = listConversations({}, { backendUrl: FIXTURE_BACKEND_URL })

    await expect(page).rejects.toThrow("500")
    await expect(page).rejects.not.toThrow("/Users/secret")
  })

  it("rejects an unreachable backend and keeps the transport failure as its cause", async () => {
    const transportFailure = createTransportFailure()
    startListBackend(() => Promise.reject(transportFailure))

    await expect(
      listConversations({}, { backendUrl: FIXTURE_BACKEND_URL })
    ).rejects.toMatchObject({ cause: transportFailure })
  })

  it("rejects with the original abort failure when the caller cancels", async () => {
    startListBackend(() => new Promise<Response>(() => {}))
    const controller = new AbortController()

    const page = listConversations(
      {},
      { backendUrl: FIXTURE_BACKEND_URL, signal: controller.signal }
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
      getConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "found", conversation })
    expect(backend.requests[0]?.url).toBe(
      `${FIXTURE_BACKEND_URL}${CONVERSATION_PATH}`
    )
  })

  it("reads a job with its parent, number, and delegator", async () => {
    const jobConversation = buildJobConversation(
      buildConversation(FIXTURE_JOB_ID, "News", [
        buildDelegatorMessage(2, "Find this week's hologram news.")
      ])
    )
    startBackendFake({
      [`GET ${JOB_PATH}`]: () => buildJsonResponse(200, jobConversation)
    })

    const result = await getConversation(FIXTURE_JOB_ID, {
      backendUrl: FIXTURE_BACKEND_URL
    })

    expect(result).toEqual({ status: "found", conversation: jobConversation })
    expect(result).toMatchObject({
      conversation: {
        kind: "job",
        parentConversationId: FIXTURE_CONVERSATION_ID,
        jobNumber: 1,
        delegatorAgentCode: "caliginia"
      }
    })
  })

  it("reads a conversation with its jobs and the reports its messages delivered", async () => {
    const conversation = buildConversationWithJobs(
      buildConversation(FIXTURE_CONVERSATION_ID, "Trip", [
        buildUserMessageWithReports(buildUserMessage(2, "Any news yet?"), [
          buildJobReport({
            id: createFixtureUuidV7(66),
            kind: "note",
            content: "Reading three feeds."
          })
        ]),
        buildCompletedAssistantMessage(3, "Nyx is still reading."),
        buildWakeUpMessage(4, [buildJobReport()])
      ]),
      [buildJob({ state: "replied" })]
    )
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () => buildJsonResponse(200, conversation)
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "found", conversation })
  })

  it("reports the declared missing conversation as not found", async () => {
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(404, buildConversationNotFoundProblem())
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "not-found" })
  })

  it("rejects an undeclared 404 instead of reporting the conversation absent", async () => {
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(404, { message: "Route not found" })
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
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
      getConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).rejects.toThrow(Error)
  })

  it("rejects a malformed conversation and keeps the decoding failure as its cause", async () => {
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(200, { id: FIXTURE_CONVERSATION_ID })
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
  })

  it("rejects an identifier that is not a UUIDv7 without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      getConversation("../agents", { backendUrl: FIXTURE_BACKEND_URL })
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })

  it.each([...PARTIAL_JOB_FIELDS, ...MISMATCHED_KIND_FIELDS])(
    "rejects a conversation with %s and keeps the decoding failure as its cause",
    async (_label, fields) => {
      startBackendFake({
        [`GET ${JOB_PATH}`]: () =>
          buildJsonResponse(200, {
            ...buildConversation(FIXTURE_JOB_ID, "News", []),
            ...fields
          })
      })

      await expect(
        getConversation(FIXTURE_JOB_ID, { backendUrl: FIXTURE_BACKEND_URL })
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ name: "ZodError" })
      })
    }
  )

  it("rejects a job that has jobs of its own and keeps the decoding failure as its cause", async () => {
    const jobConversation = buildJobConversation(
      buildConversation(FIXTURE_JOB_ID, "News", [])
    )
    startBackendFake({
      [`GET ${JOB_PATH}`]: () =>
        buildJsonResponse(200, {
          ...jobConversation,
          jobs: [buildJob({ id: createFixtureUuidV7(70) })]
        })
    })

    await expect(
      getConversation(FIXTURE_JOB_ID, { backendUrl: FIXTURE_BACKEND_URL })
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
  })

  it.each([
    ["a note without text", { kind: "note", content: "" }],
    ["a failure without its sentence", { kind: "failed", content: "" }],
    ["a stop with text", { kind: "stopped", content: "Done." }],
    ["an interruption with text", { kind: "interrupted", content: "Done." }],
    ["its source numbers out of order", { sourceNumbers: [2, 1] }],
    ["a source number twice", { sourceNumbers: [1, 1] }]
  ])(
    "rejects a delivered report with %s and keeps the decoding failure as its cause",
    async (_label, fields) => {
      startBackendFake({
        [`GET ${CONVERSATION_PATH}`]: () =>
          buildJsonResponse(
            200,
            buildConversationBodyWithReport({ ...buildJobReport(), ...fields })
          )
      })

      await expect(
        getConversation(FIXTURE_CONVERSATION_ID, {
          backendUrl: FIXTURE_BACKEND_URL
        })
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ name: "ZodError" })
      })
    }
  )

  it.each([
    ["a result without text", { kind: "result", content: "" }],
    [
      "a failure with its sentence",
      { kind: "failed", content: "The feed was down." }
    ],
    ["a stop without text", { kind: "stopped" }],
    ["an interruption without text", { kind: "interrupted" }],
    ["ascending source numbers", { sourceNumbers: [1, 3] }]
  ] as const)("reads a delivered report with %s", async (_label, fixture) => {
    const conversation = buildConversation(FIXTURE_CONVERSATION_ID, "Trip", [
      buildUserMessageWithReports(buildUserMessage(2, "Any news yet?"), [
        buildJobReport(fixture)
      ])
    ])
    startBackendFake({
      [`GET ${CONVERSATION_PATH}`]: () => buildJsonResponse(200, conversation)
    })

    await expect(
      getConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "found", conversation })
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
        { backendUrl: FIXTURE_BACKEND_URL }
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
        { backendUrl: FIXTURE_BACKEND_URL }
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
        { backendUrl: FIXTURE_BACKEND_URL }
      )
    ).resolves.toEqual({ status: "not-found" })
  })

  it("refuses to rename a job", async () => {
    startBackendFake({
      [`PATCH ${JOB_PATH}`]: () =>
        buildJsonResponse(409, buildConversationIsJobProblem())
    })

    await expect(
      updateConversationTitle(
        { conversationId: FIXTURE_JOB_ID, title: "Old news" },
        { backendUrl: FIXTURE_BACKEND_URL }
      )
    ).rejects.toThrow(JOB_CONVERSATION_MESSAGE)
  })

  it("does not report an undeclared conflict as a job", async () => {
    startBackendFake({
      [`PATCH ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(409, { message: "conflict" })
    })

    const update = updateConversationTitle(
      { conversationId: FIXTURE_CONVERSATION_ID, title: "Trip" },
      { backendUrl: FIXTURE_BACKEND_URL }
    )

    await expect(update).rejects.toThrow("409")
    await expect(update).rejects.not.toThrow(JOB_CONVERSATION_MESSAGE)
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
        { backendUrl: FIXTURE_BACKEND_URL }
      )
    ).rejects.toThrow(Error)
  })

  it.each([...PARTIAL_JOB_FIELDS, ...MISMATCHED_KIND_FIELDS])(
    "rejects metadata with %s and keeps the decoding failure as its cause",
    async (_label, fields) => {
      startBackendFake({
        [`PATCH ${JOB_PATH}`]: () =>
          buildJsonResponse(200, {
            ...buildConversationMetadata(FIXTURE_JOB_ID, "News"),
            ...fields
          })
      })

      await expect(
        updateConversationTitle(
          { conversationId: FIXTURE_JOB_ID, title: "News" },
          { backendUrl: FIXTURE_BACKEND_URL }
        )
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ name: "ZodError" })
      })
    }
  )
})

describe("deleteConversation", () => {
  it("reports the deletion the backend acknowledges", async () => {
    const backend = startBackendFake({
      [`DELETE ${CONVERSATION_PATH}`]: () => new Response(null, { status: 204 })
    })

    await expect(
      deleteConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "deleted" })
    expect(backend.requests[0]?.body).toBeUndefined()
  })

  it("reports the declared missing conversation as not found", async () => {
    startBackendFake({
      [`DELETE ${CONVERSATION_PATH}`]: () =>
        buildJsonResponse(404, buildConversationNotFoundProblem())
    })

    await expect(
      deleteConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "not-found" })
  })

  it("refuses to delete a job", async () => {
    startBackendFake({
      [`DELETE ${JOB_PATH}`]: () =>
        buildJsonResponse(409, buildConversationIsJobProblem())
    })

    await expect(
      deleteConversation(FIXTURE_JOB_ID, { backendUrl: FIXTURE_BACKEND_URL })
    ).rejects.toThrow(JOB_CONVERSATION_MESSAGE)
  })

  it.each([
    ["an unexpected success status", 200],
    ["a server failure", 500]
  ])("rejects %s", async (_label, status) => {
    startBackendFake({
      [`DELETE ${CONVERSATION_PATH}`]: () => buildJsonResponse(status, {})
    })

    await expect(
      deleteConversation(FIXTURE_CONVERSATION_ID, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).rejects.toThrow(Error)
  })
})
