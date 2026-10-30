import { describe, expect, it } from "vitest"
import {
  listMcpServers,
  sendMcpServerReconnectRequest,
  sendMcpServerSyncRequest
} from "@/lib/apis/http/mcp"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  startBackendFake
} from "../../../support/backendFake"
import {
  buildConnectedMcpState,
  buildFailedMcpState,
  buildMcpServerList,
  buildMcpServerNotFoundProblem,
  buildMcpServerStatus,
  CONNECTING_MCP_STATE
} from "../../../support/mcpFixtures"

/** Connection every case uses. */
const CONNECTION = Object.freeze({ backendUrl: FIXTURE_BACKEND_URL })

/** Route key of the list read. */
const LIST_ROUTE = "GET /api/v1/mcp/servers"

/** Route key of the sync. */
const SYNC_ROUTE = "POST /api/v1/mcp/servers/sync"

/** Route key of a reconnect of the `notes` server. */
const RECONNECT_NOTES_ROUTE = "POST /api/v1/mcp/servers/notes/reconnect"

/** List with one connected command server and one failed URL server. */
const APPLIED_LIST = buildMcpServerList([
  buildMcpServerStatus("files", "stdio", buildConnectedMcpState(3)),
  buildMcpServerStatus("notes", "http", buildFailedMcpState("unauthorized"))
])

/** List right after the `notes` server was opened again. */
const RECONNECTING_LIST = buildMcpServerList([
  buildMcpServerStatus("files", "stdio", buildConnectedMcpState(3)),
  buildMcpServerStatus("notes", "http", CONNECTING_MCP_STATE)
])

/**
 * Captures the rejection of a request expected to fail.
 *
 * @param request - Pending request.
 * @returns What the request rejected with.
 * @throws When the request resolves.
 */
async function captureFailure(request: Promise<unknown>): Promise<unknown> {
  return await request.then(
    () => {
      throw new Error("The request succeeded")
    },
    (rejection: unknown) => rejection
  )
}

describe("listMcpServers", () => {
  it("reads the list without a body, asking for JSON and no cached answer", async () => {
    const backend = startBackendFake({
      [LIST_ROUTE]: () => buildJsonResponse(200, APPLIED_LIST)
    })

    await expect(listMcpServers(CONNECTION)).resolves.toEqual(APPLIED_LIST)
    const request = backend.requests[0]
    expect(request?.url).toBe(`${FIXTURE_BACKEND_URL}/api/v1/mcp/servers`)
    expect(request?.cache).toBe("no-store")
    expect(request?.headers.get("Accept")).toBe("application/json")
    expect(request?.headers.has("Content-Type")).toBe(false)
    expect(request?.body).toBeUndefined()
  })

  it("returns a frozen list", async () => {
    startBackendFake({
      [LIST_ROUTE]: () => buildJsonResponse(200, APPLIED_LIST)
    })

    const list = await listMcpServers(CONNECTION)

    expect(Object.isFrozen(list)).toBe(true)
    expect(Object.isFrozen(list.servers)).toBe(true)
  })

  it("rejects without the transport's detail when the backend cannot be reached", async () => {
    startBackendFake({
      [LIST_ROUTE]: () => Promise.reject(createTransportFailure())
    })

    const failure = await captureFailure(listMcpServers(CONNECTION))

    expect(failure).toMatchObject({
      message: "The backend could not be reached.",
      cause: expect.any(TypeError)
    })
  })

  it("rejects a list that does not match the shared schema, keeping why", async () => {
    startBackendFake({
      [LIST_ROUTE]: () =>
        buildJsonResponse(200, {
          settings: "applied",
          servers: [{ name: "notes", transport: "http", state: {} }]
        })
    })

    const failure = await captureFailure(listMcpServers(CONNECTION))

    expect(failure).toMatchObject({
      message: "The backend returned an invalid MCP server list.",
      cause: expect.objectContaining({ name: "ZodError" })
    })
  })

  it.each([
    ["accepts", 127, "connected"],
    ["rejects", 128, undefined]
  ])(
    "%s a connected server whose listed and skipped tools together are %i plus one",
    async (_label, toolCount, expectedStatus) => {
      startBackendFake({
        [LIST_ROUTE]: () =>
          buildJsonResponse(200, {
            settings: "applied",
            servers: [
              {
                name: "notes",
                transport: "http",
                state: {
                  status: "connected",
                  toolCount,
                  skippedTools: [{ name: "tag", reason: "duplicate-name" }],
                  isToolListCut: true
                }
              }
            ]
          })
      })

      const read = await listMcpServers(CONNECTION).then(
        (list) => list.servers[0]?.state.status,
        () => undefined
      )

      expect(read).toBe(expectedStatus)
    }
  )

  it("rejects an answer with another status, naming only the status", async () => {
    startBackendFake({
      [LIST_ROUTE]: () =>
        buildJsonResponse(500, { detail: "SERVER-PROVIDED-TEXT" })
    })

    const failure = await captureFailure(listMcpServers(CONNECTION))

    expect(failure).toMatchObject({
      message:
        "The backend could not complete the MCP server request (HTTP 500)."
    })
  })

  it.each([
    [
      "another media type",
      () =>
        new Response(JSON.stringify(APPLIED_LIST), {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        })
    ],
    [
      "a body that is not JSON",
      () =>
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    ]
  ])("rejects an answer with %s", async (_label, route) => {
    startBackendFake({ [LIST_ROUTE]: route })

    await expect(listMcpServers(CONNECTION)).rejects.toMatchObject({
      message: "The backend returned an invalid MCP server list."
    })
  })
})

describe("sendMcpServerSyncRequest", () => {
  it("posts the empty JSON body and returns the list the backend applied", async () => {
    const backend = startBackendFake({
      [SYNC_ROUTE]: () => buildJsonResponse(200, RECONNECTING_LIST)
    })

    await expect(sendMcpServerSyncRequest(CONNECTION)).resolves.toEqual(
      RECONNECTING_LIST
    )
    const request = backend.requests[0]
    expect(request?.method).toBe("POST")
    expect(request?.url).toBe(`${FIXTURE_BACKEND_URL}/api/v1/mcp/servers/sync`)
    expect(request?.headers.get("Content-Type")).toBe("application/json")
    expect(request?.body).toEqual({})
    expect(request?.cache).toBe("no-store")
  })

  it("rejects an answer with another status, naming the status", async () => {
    startBackendFake({
      [SYNC_ROUTE]: () => new Response(null, { status: 500 })
    })

    await expect(sendMcpServerSyncRequest(CONNECTION)).rejects.toMatchObject({
      message:
        "The backend could not complete the MCP server request (HTTP 500)."
    })
  })

  it("rejects a list that does not match the shared schema", async () => {
    startBackendFake({
      [SYNC_ROUTE]: () => buildJsonResponse(200, { settings: "applied" })
    })

    await expect(sendMcpServerSyncRequest(CONNECTION)).rejects.toMatchObject({
      message: "The backend returned an invalid MCP server list."
    })
  })

  it("rejects without the transport's detail when the backend cannot be reached", async () => {
    startBackendFake({
      [SYNC_ROUTE]: () => Promise.reject(createTransportFailure())
    })

    await expect(sendMcpServerSyncRequest(CONNECTION)).rejects.toMatchObject({
      message: "The backend could not be reached."
    })
  })
})

describe("sendMcpServerReconnectRequest", () => {
  it("posts the empty JSON body to the server's path and returns the list", async () => {
    const backend = startBackendFake({
      [RECONNECT_NOTES_ROUTE]: () => buildJsonResponse(200, RECONNECTING_LIST)
    })

    await expect(
      sendMcpServerReconnectRequest(CONNECTION, "notes")
    ).resolves.toEqual({
      status: "reconnected",
      list: RECONNECTING_LIST
    })
    const request = backend.requests[0]
    expect(request?.method).toBe("POST")
    expect(request?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/mcp/servers/notes/reconnect`
    )
    expect(request?.headers.get("Content-Type")).toBe("application/json")
    expect(request?.body).toEqual({})
  })

  it("answers not-found for the declared problem", async () => {
    startBackendFake({
      [RECONNECT_NOTES_ROUTE]: () =>
        buildJsonResponse(404, buildMcpServerNotFoundProblem("notes"))
    })

    await expect(
      sendMcpServerReconnectRequest(CONNECTION, "notes")
    ).resolves.toEqual({
      status: "not-found"
    })
  })

  it.each([
    ["another body", () => buildJsonResponse(404, { message: "Not Found" })],
    ["no body", () => new Response(null, { status: 404 })]
  ])(
    "rejects a 404 with %s, which does not show the server is absent",
    async (_label, route) => {
      startBackendFake({ [RECONNECT_NOTES_ROUTE]: route })

      await expect(
        sendMcpServerReconnectRequest(CONNECTION, "notes")
      ).rejects.toMatchObject({
        message:
          "The backend could not complete the MCP server request (HTTP 404)."
      })
    }
  )

  it("rejects an answer with another status, naming the status", async () => {
    startBackendFake({
      [RECONNECT_NOTES_ROUTE]: () => new Response(null, { status: 503 })
    })

    await expect(
      sendMcpServerReconnectRequest(CONNECTION, "notes")
    ).rejects.toMatchObject({
      message:
        "The backend could not complete the MCP server request (HTTP 503)."
    })
  })

  it("rejects without the transport's detail when the backend cannot be reached", async () => {
    startBackendFake({
      [RECONNECT_NOTES_ROUTE]: () => Promise.reject(createTransportFailure())
    })

    await expect(
      sendMcpServerReconnectRequest(CONNECTION, "notes")
    ).rejects.toMatchObject({ message: "The backend could not be reached." })
  })
})
