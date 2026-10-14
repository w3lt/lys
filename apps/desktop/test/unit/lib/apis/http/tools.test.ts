import type { CheckWebSearchKeyApiResponse } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { listBackendTools, sendWebSearchKeyCheck } from "@/lib/apis/http/tools"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  startBackendFake
} from "../../../support/backendFake"
import {
  buildBackendToolDefinition,
  buildToolDefinition
} from "../../../support/toolFixtures"

/** Connection the cases pass. */
const CONNECTION = Object.freeze({ backendUrl: FIXTURE_BACKEND_URL })

/** Route key of the backend's tool list. */
const TOOLS_ROUTE = "GET /api/v1/tools"

/** Tool the backend runs. */
const READ_PAGE = buildBackendToolDefinition("read_page")

/** Backend tool that can lack what it needs to run. */
const WEB_SEARCH = buildBackendToolDefinition("web_search")

/** Route key of the key check. */
const KEY_CHECK_ROUTE = "POST /api/v1/tools/web_search/key-check"

/** Answer of a check Tavily accepted, with the plan's credits. */
const ACCEPTED_CHECK: CheckWebSearchKeyApiResponse = Object.freeze({
  status: "accepted",
  credits: Object.freeze({ used: 12, limit: 1_000 })
})

/**
 * Sends a key check against one answer and returns the rejection.
 *
 * @param response - Answer of the key-check route.
 * @returns What `sendWebSearchKeyCheck` rejected with.
 * @throws When the check resolves instead.
 */
async function getKeyCheckFailure(response: Response): Promise<unknown> {
  startBackendFake({ [KEY_CHECK_ROUTE]: () => response })
  return await sendWebSearchKeyCheck(CONNECTION).then(
    () => {
      throw new Error("The check resolved")
    },
    (failure: unknown) => failure
  )
}

/**
 * Lists the backend's tools against one answer and returns the rejection.
 *
 * @param response - Answer of the tool-list route.
 * @returns What `listBackendTools` rejected with.
 * @throws When the list resolves instead.
 */
async function getListBackendToolsFailure(
  response: Response
): Promise<unknown> {
  startBackendFake({ [TOOLS_ROUTE]: () => response })
  return await listBackendTools(CONNECTION).then(
    () => {
      throw new Error("The list resolved")
    },
    (failure: unknown) => failure
  )
}

describe("listBackendTools", () => {
  it("reads the list at the backend origin, uncached, and returns the frozen definitions in order", async () => {
    const backend = startBackendFake({
      [TOOLS_ROUTE]: () =>
        buildJsonResponse(200, {
          tools: [READ_PAGE, WEB_SEARCH],
          unavailableTools: []
        })
    })

    const list = await listBackendTools(CONNECTION)

    expect(list).toEqual({
      tools: [READ_PAGE, WEB_SEARCH],
      unavailableTools: new Map()
    })
    expect(Object.isFrozen(list)).toBe(true)
    expect(Object.isFrozen(list.tools)).toBe(true)
    expect(backend.requests[0]?.url).toBe(`${FIXTURE_BACKEND_URL}/api/v1/tools`)
    expect(backend.requests[0]?.headers.get("accept")).toBe("application/json")
    expect(backend.requests[0]?.cache).toBe("no-store")
  })

  it("keeps why each listed tool that cannot run now cannot, by name", async () => {
    startBackendFake({
      [TOOLS_ROUTE]: () =>
        buildJsonResponse(200, {
          tools: [READ_PAGE, WEB_SEARCH],
          unavailableTools: [{ name: "web_search", reason: "api-key-missing" }]
        })
    })

    const list = await listBackendTools(CONNECTION)

    expect(list.unavailableTools).toEqual(
      new Map([["web_search", "api-key-missing"]])
    )
  })

  it("returns an empty list when the backend runs no tool", async () => {
    startBackendFake({
      [TOOLS_ROUTE]: () =>
        buildJsonResponse(200, { tools: [], unavailableTools: [] })
    })

    await expect(listBackendTools(CONNECTION)).resolves.toEqual({
      tools: [],
      unavailableTools: new Map()
    })
  })

  it.each([
    [
      "a failure status, even with a list body",
      buildJsonResponse(500, { tools: [READ_PAGE] })
    ],
    [
      "a list body not declared as JSON",
      new Response(JSON.stringify({ tools: [READ_PAGE] }), {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      })
    ]
  ])("rejects %s with a caller-safe error", async (_label, response) => {
    const failure = await getListBackendToolsFailure(response)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "The backend returned an invalid tool list."
    })
  })

  it.each([
    [
      "a tool the desktop runs",
      {
        tools: [READ_PAGE, buildToolDefinition("find_files")],
        unavailableTools: []
      }
    ],
    [
      "a tool name twice",
      { tools: [READ_PAGE, READ_PAGE], unavailableTools: [] }
    ],
    ["no availability", { tools: [READ_PAGE] }],
    [
      "an unavailable tool it does not list",
      {
        tools: [READ_PAGE],
        unavailableTools: [{ name: "web_search", reason: "api-key-missing" }]
      }
    ],
    [
      "an unavailable tool named twice",
      {
        tools: [WEB_SEARCH],
        unavailableTools: [
          { name: "web_search", reason: "api-key-missing" },
          { name: "web_search", reason: "api-key-invalid" }
        ]
      }
    ],
    [
      "a reason Lys does not know",
      {
        tools: [WEB_SEARCH],
        unavailableTools: [{ name: "web_search", reason: "quota-used-up" }]
      }
    ]
  ])(
    "rejects a list with %s, keeping the decoding failure as its cause",
    async (_label, body) => {
      const failure = await getListBackendToolsFailure(
        buildJsonResponse(200, body)
      )

      expect(failure).toMatchObject({
        message: "The backend returned an invalid tool list.",
        cause: expect.objectContaining({ name: "ZodError" })
      })
    }
  )

  it("rejects when the backend cannot be reached and keeps the transport failure as its cause", async () => {
    const transportFailure = createTransportFailure()
    startBackendFake({ [TOOLS_ROUTE]: () => Promise.reject(transportFailure) })

    await expect(listBackendTools(CONNECTION)).rejects.toMatchObject({
      message: "The backend could not be reached.",
      cause: transportFailure
    })
  })
})

describe("sendWebSearchKeyCheck", () => {
  it("posts an empty JSON object to the backend origin, uncached, and returns the frozen outcome", async () => {
    const backend = startBackendFake({
      [KEY_CHECK_ROUTE]: () => buildJsonResponse(200, ACCEPTED_CHECK)
    })

    const outcome = await sendWebSearchKeyCheck(CONNECTION)

    expect(outcome).toEqual(ACCEPTED_CHECK)
    expect(Object.isFrozen(outcome)).toBe(true)
    const [request] = backend.requests
    expect(request?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/tools/web_search/key-check`
    )
    expect(request?.body).toEqual({})
    expect(request?.headers.get("content-type")).toBe("application/json")
    expect(request?.headers.get("accept")).toBe("application/json")
    expect(request?.cache).toBe("no-store")
  })

  it.each<CheckWebSearchKeyApiResponse>([
    { status: "accepted", credits: null },
    { status: "rejected" },
    { status: "unavailable", reason: "api-key-missing" },
    { status: "failed", reason: "timed-out" }
  ])(
    "returns the $status outcome as the backend answered it",
    async (answer) => {
      startBackendFake({
        [KEY_CHECK_ROUTE]: () => buildJsonResponse(200, answer)
      })

      await expect(sendWebSearchKeyCheck(CONNECTION)).resolves.toEqual(answer)
    }
  )

  it.each([
    [
      "a failure status, even with an outcome body",
      buildJsonResponse(400, ACCEPTED_CHECK)
    ],
    [
      "an outcome body not declared as JSON",
      new Response(JSON.stringify(ACCEPTED_CHECK), {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      })
    ]
  ])("rejects %s with a caller-safe error", async (_label, response) => {
    const failure = await getKeyCheckFailure(response)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "The backend returned an invalid key check."
    })
  })

  it("rejects an outcome that does not match the shared schema, keeping the decoding failure as its cause", async () => {
    const failure = await getKeyCheckFailure(
      buildJsonResponse(200, { status: "accepted", apiKey: "tvly-leaked" })
    )

    expect(failure).toMatchObject({
      message: "The backend returned an invalid key check.",
      cause: expect.objectContaining({ name: "ZodError" })
    })
  })

  it("rejects when the backend cannot be reached and keeps the transport failure as its cause", async () => {
    const transportFailure = createTransportFailure()
    startBackendFake({
      [KEY_CHECK_ROUTE]: () => Promise.reject(transportFailure)
    })

    await expect(sendWebSearchKeyCheck(CONNECTION)).rejects.toMatchObject({
      message: "The backend could not be reached.",
      cause: transportFailure
    })
  })
})
