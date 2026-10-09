import { describe, expect, it } from "vitest"
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent
} from "@/lib/apis/http/agents"
import {
  buildJsonResponse,
  startBackendFake
} from "../../../support/backendFake"
import {
  buildAgent,
  buildAgentCodeTakenProblem,
  buildAgentListPage,
  buildAgentNotFoundProblem,
  buildAgentSummary
} from "../../../support/agentFixtures"

/** Backend origin the cases pass; it differs from the production default. */
const BACKEND_URL = "http://backend.test:4100"

/** Connection the cases do not cancel. */
const CONNECTION = Object.freeze({ backendUrl: BACKEND_URL })

/** Agent the single-agent cases address. */
const RESEARCHER = buildAgent("researcher", {
  name: "Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web."
})

describe("listAgents", () => {
  it("requests the first page without a query string and returns it", async () => {
    const page = buildAgentListPage([RESEARCHER])
    const backend = startBackendFake({
      "GET /api/v1/agents": () => buildJsonResponse(200, page)
    })
    const signal = new AbortController().signal

    await expect(
      listAgents({}, { backendUrl: BACKEND_URL, signal })
    ).resolves.toEqual(page)
    expect(backend.requests[0]?.url).toBe(`${BACKEND_URL}/api/v1/agents`)
    expect(backend.requests[0]?.signal).toBe(signal)
    expect(backend.requests[0]?.cache).toBe("no-store")
    expect(backend.requests[0]?.headers.has("Content-Type")).toBe(false)
  })

  it("sends the cursor and page size", async () => {
    const backend = startBackendFake({
      "GET /api/v1/agents": () => buildJsonResponse(200, buildAgentListPage([]))
    })

    await listAgents({ cursor: "next+page", limit: 1 }, CONNECTION)

    const searchParams = new URL(backend.requests[0]?.url ?? "").searchParams
    expect(Object.fromEntries(searchParams)).toEqual({
      cursor: "next+page",
      limit: "1"
    })
  })

  it.each([
    ["a page size of zero", { limit: 0 }],
    ["a page size over the maximum", { limit: 51 }]
  ])("rejects %s without contacting the backend", async (_label, query) => {
    const backend = startBackendFake({})

    await expect(listAgents(query, CONNECTION)).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })

  it("rejects a page that lists an agent twice", async () => {
    const summary = buildAgentSummary(RESEARCHER)
    startBackendFake({
      "GET /api/v1/agents": () =>
        buildJsonResponse(200, {
          agents: [summary, summary],
          storedCount: 2,
          nextCursor: null
        })
    })

    await expect(listAgents({}, CONNECTION)).rejects.toThrow(Error)
  })

  it("rejects a page that lists more agents than are stored", async () => {
    startBackendFake({
      "GET /api/v1/agents": () =>
        buildJsonResponse(200, {
          agents: [buildAgentSummary(RESEARCHER)],
          storedCount: 0,
          nextCursor: null
        })
    })

    await expect(listAgents({}, CONNECTION)).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" })
    })
  })

  it("rejects a failed status, naming only the status", async () => {
    startBackendFake({
      "GET /api/v1/agents": () =>
        buildJsonResponse(500, { detail: "at /Users/secret/db" })
    })

    const page = listAgents({}, CONNECTION)

    await expect(page).rejects.toThrow("500")
    await expect(page).rejects.not.toThrow("/Users/secret")
  })

  it("rejects an unreachable backend and keeps the transport failure as its cause", async () => {
    const transportFailure = new TypeError("fetch failed")
    startBackendFake({
      "GET /api/v1/agents": () => Promise.reject(transportFailure)
    })

    await expect(listAgents({}, CONNECTION)).rejects.toMatchObject({
      cause: transportFailure
    })
  })

  it("rejects with the original abort failure when the caller cancels", async () => {
    startBackendFake({
      "GET /api/v1/agents": () => new Promise<Response>(() => {})
    })
    const controller = new AbortController()

    const page = listAgents(
      {},
      { backendUrl: BACKEND_URL, signal: controller.signal }
    )
    controller.abort()

    await expect(page).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("getAgent", () => {
  it("returns the stored agent", async () => {
    const backend = startBackendFake({
      "GET /api/v1/agents/researcher": () => buildJsonResponse(200, RESEARCHER)
    })

    await expect(getAgent("researcher", CONNECTION)).resolves.toEqual({
      status: "found",
      agent: RESEARCHER
    })
    expect(backend.requests[0]?.url).toBe(
      `${BACKEND_URL}/api/v1/agents/researcher`
    )
  })

  it("reports the declared missing agent as not found", async () => {
    startBackendFake({
      "GET /api/v1/agents/researcher": () =>
        buildJsonResponse(404, buildAgentNotFoundProblem())
    })

    await expect(getAgent("researcher", CONNECTION)).resolves.toEqual({
      status: "not-found"
    })
  })

  it("rejects an undeclared 404 instead of reporting the agent absent", async () => {
    startBackendFake({
      "GET /api/v1/agents/researcher": () =>
        buildJsonResponse(404, { message: "Route not found" })
    })

    await expect(getAgent("researcher", CONNECTION)).rejects.toThrow("404")
  })

  it("rejects a different agent than the one requested", async () => {
    startBackendFake({
      "GET /api/v1/agents/researcher": () =>
        buildJsonResponse(200, buildAgent("writer"))
    })

    await expect(getAgent("researcher", CONNECTION)).rejects.toThrow(Error)
  })

  it("rejects a code that is not a valid agent code without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(getAgent("../conversations", CONNECTION)).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })
})

describe("createAgent", () => {
  it("sends the trimmed definition and returns the stored agent", async () => {
    const backend = startBackendFake({
      "POST /api/v1/agents": () => buildJsonResponse(201, RESEARCHER)
    })

    await expect(
      createAgent(
        {
          code: "researcher",
          name: " Researcher ",
          bio: "Searches the web.\n",
          systemPrompt: "  You research the web."
        },
        CONNECTION
      )
    ).resolves.toEqual({ status: "created", agent: RESEARCHER })
    expect(backend.requests[0]?.body).toEqual({
      code: "researcher",
      name: "Researcher",
      bio: "Searches the web.",
      systemPrompt: "You research the web."
    })
    expect(backend.requests[0]?.headers.get("Content-Type")).toBe(
      "application/json"
    )
  })

  it("omits the code so the backend derives one, and accepts the derived code", async () => {
    const backend = startBackendFake({
      "POST /api/v1/agents": () => buildJsonResponse(201, RESEARCHER)
    })

    await expect(
      createAgent(
        {
          name: "Researcher",
          bio: "Searches the web.",
          systemPrompt: "You research the web."
        },
        CONNECTION
      )
    ).resolves.toEqual({ status: "created", agent: RESEARCHER })
    expect(backend.requests[0]?.body).not.toHaveProperty("code")
  })

  it("reports the declared taken code without storing anything", async () => {
    startBackendFake({
      "POST /api/v1/agents": () =>
        buildJsonResponse(409, buildAgentCodeTakenProblem())
    })

    await expect(
      createAgent(
        { code: "researcher", name: "R", bio: "B", systemPrompt: "P" },
        CONNECTION
      )
    ).resolves.toEqual({ status: "code-taken" })
  })

  it.each([
    ["an undeclared conflict", 409, { message: "conflict" }],
    ["a success status other than 201", 200, RESEARCHER]
  ])("rejects %s", async (_label, status, body) => {
    startBackendFake({
      "POST /api/v1/agents": () => buildJsonResponse(status, body)
    })

    await expect(
      createAgent(
        { code: "researcher", name: "R", bio: "B", systemPrompt: "P" },
        CONNECTION
      )
    ).rejects.toThrow(Error)
  })

  it("rejects an agent stored under a code other than the one given", async () => {
    startBackendFake({
      "POST /api/v1/agents": () => buildJsonResponse(201, buildAgent("writer"))
    })

    await expect(
      createAgent(
        { code: "researcher", name: "R", bio: "B", systemPrompt: "P" },
        CONNECTION
      )
    ).rejects.toThrow(Error)
  })

  it("rejects a blank name without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      createAgent({ name: "  ", bio: "B", systemPrompt: "P" }, CONNECTION)
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })
})

describe("updateAgent", () => {
  it("sends only the trimmed changes and returns the changed agent", async () => {
    const changed = buildAgent("researcher", { name: "Scout" })
    const backend = startBackendFake({
      "PATCH /api/v1/agents/researcher": () => buildJsonResponse(200, changed)
    })

    await expect(
      updateAgent(
        { agentCode: "researcher", changes: { name: " Scout " } },
        CONNECTION
      )
    ).resolves.toEqual({ status: "updated", agent: changed })
    expect(backend.requests[0]?.body).toEqual({ name: "Scout" })
  })

  it("rejects a change that changes nothing without contacting the backend", async () => {
    const backend = startBackendFake({})

    await expect(
      updateAgent({ agentCode: "researcher", changes: {} }, CONNECTION)
    ).rejects.toThrow()
    expect(backend.requests).toEqual([])
  })

  it("reports the declared missing agent as not found", async () => {
    startBackendFake({
      "PATCH /api/v1/agents/researcher": () =>
        buildJsonResponse(404, buildAgentNotFoundProblem())
    })

    await expect(
      updateAgent(
        { agentCode: "researcher", changes: { bio: "B" } },
        CONNECTION
      )
    ).resolves.toEqual({ status: "not-found" })
  })

  it("rejects a different agent than the one changed", async () => {
    startBackendFake({
      "PATCH /api/v1/agents/researcher": () =>
        buildJsonResponse(200, buildAgent("writer"))
    })

    await expect(
      updateAgent(
        { agentCode: "researcher", changes: { bio: "B" } },
        CONNECTION
      )
    ).rejects.toThrow(Error)
  })
})

describe("deleteAgent", () => {
  it("reports the deletion the backend acknowledges", async () => {
    const backend = startBackendFake({
      "DELETE /api/v1/agents/researcher": () =>
        new Response(null, { status: 204 })
    })

    await expect(deleteAgent("researcher", CONNECTION)).resolves.toEqual({
      status: "deleted"
    })
    expect(backend.requests[0]?.body).toBeUndefined()
  })

  it("reports the declared missing agent as not found", async () => {
    startBackendFake({
      "DELETE /api/v1/agents/researcher": () =>
        buildJsonResponse(404, buildAgentNotFoundProblem())
    })

    await expect(deleteAgent("researcher", CONNECTION)).resolves.toEqual({
      status: "not-found"
    })
  })

  it.each([
    ["an unexpected success status", 200],
    ["a server failure", 500]
  ])("rejects %s", async (_label, status) => {
    startBackendFake({
      "DELETE /api/v1/agents/researcher": () => buildJsonResponse(status, {})
    })

    await expect(deleteAgent("researcher", CONNECTION)).rejects.toThrow(Error)
  })
})
