import { describe, expect, it } from "vitest"
import { listBackendTools } from "@/lib/apis/http/tools"
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
    const searchWeb = buildBackendToolDefinition("search_web")
    const backend = startBackendFake({
      [TOOLS_ROUTE]: () =>
        buildJsonResponse(200, { tools: [READ_PAGE, searchWeb] })
    })

    const tools = await listBackendTools(CONNECTION)

    expect(tools).toEqual([READ_PAGE, searchWeb])
    expect(Object.isFrozen(tools)).toBe(true)
    expect(backend.requests[0]?.url).toBe(`${FIXTURE_BACKEND_URL}/api/v1/tools`)
    expect(backend.requests[0]?.headers.get("accept")).toBe("application/json")
    expect(backend.requests[0]?.cache).toBe("no-store")
  })

  it("returns an empty list when the backend runs no tool", async () => {
    startBackendFake({
      [TOOLS_ROUTE]: () => buildJsonResponse(200, { tools: [] })
    })

    await expect(listBackendTools(CONNECTION)).resolves.toEqual([])
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
    ["a tool the desktop runs", [READ_PAGE, buildToolDefinition("find_files")]],
    ["a tool name twice", [READ_PAGE, READ_PAGE]]
  ])(
    "rejects a list with %s, keeping the decoding failure as its cause",
    async (_label, tools) => {
      const failure = await getListBackendToolsFailure(
        buildJsonResponse(200, { tools })
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
