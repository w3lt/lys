import {
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema
} from "@lys/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import StoredAgents from "../../../../src/di/services/agentService/agents"
import { updateFastifyWithHttpTransport } from "../../../../src/http"
import SqliteAgentRecordStore from "../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import updateFastifyWithAgentRoutes from "../../../../src/modules/agent"
import { createConversationListCursor } from "../../../../src/modules/conversation/listOptions"
import { openTestDatabase } from "../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"
import { createTestFastify } from "../../support/fastifyTestApp"

/** Time the clock reads when a case starts. */
const NOW = "2026-05-06T07:08:09.123Z"

/** Time a case moves the clock to before a later change. */
const LATER = "2026-05-07T00:00:00.000Z"

/** Definition of the agent most cases create. */
const LYS_DEFINITION = Object.freeze({
  code: "lys",
  name: "Lys",
  bio: "Personal assistant.",
  systemPrompt: "You are Lys."
})

/** {@link LYS_DEFINITION} as stored at {@link NOW}. */
const STORED_LYS = Object.freeze({
  ...LYS_DEFINITION,
  createdAt: NOW,
  updatedAt: NOW
})

/**
 * Encodes a list cursor naming one agent created at {@link NOW}, its JSON
 * padded with trailing spaces so the cursor has an exact length.
 *
 * @param code - Code of the agent the cursor names.
 * @param length - Length of the cursor text, a multiple of four so that the
 * base64 is canonical without padding.
 * @returns A cursor the list endpoint can decode.
 */
function createPaddedAgentListCursor(code: string, length: number): string {
  const json = JSON.stringify({ version: 1, createdAt: NOW, code })
  return Buffer.from(json.padEnd((length / 4) * 3, " "), "utf8").toString(
    "base64"
  )
}

/**
 * Creates an application with the HTTP transport and the agent routes over
 * the real agent service and an in-memory database owned by the current test.
 *
 * @returns The application and the decorated service, on which a case may
 * spy; the routes read the service at registration.
 */
async function createAgentRouteApp() {
  const { app } = createTestFastify()
  const agents = new StoredAgents(
    new SqliteAgentRecordStore(openTestDatabase())
  )
  await updateFastifyWithHttpTransport(app)
  app.decorate("agents", agents)
  await updateFastifyWithAgentRoutes(app)
  return { app, agents }
}

describe("updateFastifyWithAgentRoutes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("rejects rather than throws when a route cannot be registered", async () => {
    const { app } = await createAgentRouteApp()

    const registration = updateFastifyWithAgentRoutes(app)

    await expect(registration).rejects.toMatchObject({
      code: "FST_ERR_DUPLICATED_ROUTE"
    })
  })

  describe("GET /api/v1/agents", () => {
    it("responds with an empty final page when no agent is stored", async () => {
      const { app } = await createAgentRouteApp()

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents"
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        agents: [],
        storedCount: 0,
        nextCursor: null
      })
    })

    it("pages through summaries oldest first, then by code", async () => {
      const { app, agents } = await createAgentRouteApp()
      agents.createAgent({ ...LYS_DEFINITION, code: "b" })
      agents.createAgent({ ...LYS_DEFINITION, code: "a" })
      vi.setSystemTime(new Date(LATER))
      agents.createAgent({ ...LYS_DEFINITION, code: "c" })

      const first = await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        query: { limit: "2" }
      })
      const firstPage = first.json()
      const second = await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        query: { limit: "2", cursor: firstPage.nextCursor }
      })

      expect(first.statusCode).toBe(200)
      expect(firstPage).toMatchObject({ storedCount: 3 })
      expect(firstPage.agents).toEqual([
        {
          code: "a",
          name: "Lys",
          bio: "Personal assistant.",
          createdAt: NOW,
          updatedAt: NOW
        },
        {
          code: "b",
          name: "Lys",
          bio: "Personal assistant.",
          createdAt: NOW,
          updatedAt: NOW
        }
      ])
      expect(second.statusCode).toBe(200)
      expect(second.json()).toMatchObject({
        agents: [{ code: "c", createdAt: LATER }],
        storedCount: 3,
        nextCursor: null
      })
    })

    it.each([
      ["1", 1],
      ["50", 50]
    ])("serves a page of the requested size %s", async (limit, pageSize) => {
      const { app, agents } = await createAgentRouteApp()
      for (let index = 0; index < 51; index += 1)
        agents.createAgent({ ...LYS_DEFINITION, code: `agent-${index}` })

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        query: { limit }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().agents).toHaveLength(pageSize)
      expect(response.json()).toMatchObject({
        storedCount: 51,
        nextCursor: expect.any(String)
      })
    })

    it("continues after a cursor of the maximum length", async () => {
      const { app, agents } = await createAgentRouteApp()
      agents.createAgent({ ...LYS_DEFINITION, code: "a" })
      agents.createAgent({ ...LYS_DEFINITION, code: "b" })
      const cursor = createPaddedAgentListCursor("a", 2048)

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        query: { cursor }
      })

      expect(cursor).toHaveLength(2048)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        agents: [{ code: "b" }],
        nextCursor: null
      })
    })

    it.each([
      ["a zero page size", { limit: "0" }],
      ["a page size above the maximum", { limit: "51" }],
      ["a fractional page size", { limit: "1.5" }],
      ["an empty cursor", { cursor: "" }],
      [
        "a cursor over the maximum length",
        { cursor: createPaddedAgentListCursor("a", 2052) }
      ],
      ["an unknown parameter", { sort: "name" }],
      ["a cursor that is not an agent cursor", { cursor: "bm90IGpzb24=" }],
      [
        "a conversation list cursor",
        {
          cursor: createConversationListCursor("", {
            id: createFixtureUuidV7(1),
            title: null,
            createdAt: NOW,
            updatedAt: NOW,
            preview: null
          })
        }
      ]
    ])("rejects %s without listing", async (_label, query) => {
      const { app, agents } = await createAgentRouteApp()
      const listAgents = vi.spyOn(agents, "listAgents")

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        query
      })

      expect(response.statusCode).toBe(400)
      expect(listAgents).not.toHaveBeenCalled()
    })

    it("responds with a server error when the agents cannot be listed", async () => {
      const { app, agents } = await createAgentRouteApp()
      vi.spyOn(agents, "listAgents").mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents"
      })

      expect(response.statusCode).toBe(500)
    })
  })

  describe("POST /api/v1/agents", () => {
    it("stores the agent under the given code and names its location", async () => {
      const { app } = await createAgentRouteApp()

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload: LYS_DEFINITION
      })

      expect(response.statusCode).toBe(201)
      expect(response.json()).toEqual(STORED_LYS)
      expect(response.headers.location).toBe("/api/v1/agents/lys")
      const stored = await app.inject({
        method: "GET",
        url: "/api/v1/agents/lys"
      })
      expect(stored.json()).toEqual(STORED_LYS)
    })

    it("derives the code from the name when none is given", async () => {
      const { app } = await createAgentRouteApp()
      const payload = {
        name: "Web Researcher",
        bio: "Searches the web.",
        systemPrompt: "You research the web."
      }

      const first = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload
      })
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload
      })

      expect(first.statusCode).toBe(201)
      expect(first.json()).toMatchObject({ code: "web-researcher" })
      expect(second.statusCode).toBe(201)
      expect(second.json()).toMatchObject({ code: "web-researcher-2" })
      expect(second.headers.location).toBe("/api/v1/agents/web-researcher-2")
    })

    it("stores the name, bio, and system prompt trimmed", async () => {
      const { app } = await createAgentRouteApp()

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload: {
          code: "lys",
          name: "  Lys  ",
          bio: "\tPersonal assistant.\n",
          systemPrompt: "\n You are Lys. \n"
        }
      })

      expect(response.statusCode).toBe(201)
      expect(response.json()).toEqual(STORED_LYS)
    })

    it.each([
      ["a code", { code: "a".repeat(64) }, { code: "a".repeat(64) }],
      [
        "a name, after trimming",
        { name: ` ${"n".repeat(64)} ` },
        { name: "n".repeat(64) }
      ],
      [
        "a bio, after trimming",
        { bio: `\t${"b".repeat(128)}\n` },
        { bio: "b".repeat(128) }
      ]
    ])("accepts %s of the maximum length", async (_label, change, stored) => {
      const { app } = await createAgentRouteApp()

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload: { ...LYS_DEFINITION, ...change }
      })

      expect(response.statusCode).toBe(201)
      expect(response.json()).toMatchObject(stored)
    })

    it("stores text that starts with a NUL character", async () => {
      const { app, agents } = await createAgentRouteApp()

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload: { ...LYS_DEFINITION, name: "\u0000Lys" }
      })

      expect(response.statusCode).toBe(201)
      expect(agents.findAgent("lys")).toMatchObject({ name: "\u0000Lys" })
    })

    it("responds with the code-taken problem and keeps the stored agent", async () => {
      const { app, agents } = await createAgentRouteApp()
      agents.createAgent(LYS_DEFINITION)
      vi.setSystemTime(new Date(LATER))

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload: { ...LYS_DEFINITION, name: "Impostor" }
      })

      expect(response.statusCode).toBe(409)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(agentCodeTakenProblemSchema.parse(response.json())).toMatchObject({
        instance: "/api/v1/agents"
      })
      expect(agents.findAgent("lys")).toEqual(STORED_LYS)
    })

    it.each([
      ["an empty code", { code: "" }],
      ["an uppercase code", { code: "Lys" }],
      ["a code with a leading hyphen", { code: "-lys" }],
      ["a code with a trailing hyphen", { code: "lys-" }],
      ["a code with a doubled hyphen", { code: "web--researcher" }],
      ["a code with a surrounding space", { code: " lys" }],
      ["a code with an underscore", { code: "web_researcher" }],
      ["a code over the maximum length", { code: "a".repeat(65) }],
      ["a blank name", { name: " \n\t " }],
      ["a blank bio", { bio: "   " }],
      ["a blank system prompt", { systemPrompt: "\n" }],
      ["a name over the maximum length", { name: "n".repeat(65) }],
      ["a bio over the maximum length", { bio: "b".repeat(129) }],
      ["a name with a lone surrogate", { name: "\ud800Lys" }],
      ["a system prompt with a lone surrogate", { systemPrompt: "You\udc00" }],
      ["an unknown field", { model: "qwen/qwen3-8b" }],
      ["a missing system prompt", { systemPrompt: undefined }]
    ])("rejects %s without storing anything", async (_label, change) => {
      const { app, agents } = await createAgentRouteApp()
      const createAgent = vi.spyOn(agents, "createAgent")

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload: { ...LYS_DEFINITION, ...change }
      })

      expect(response.statusCode).toBe(400)
      expect(createAgent).not.toHaveBeenCalled()
      expect(agents.listAgents({ cursor: undefined, limit: 1 })).toMatchObject({
        storedCount: 0
      })
    })

    it("responds with a server error when the agent cannot be stored", async () => {
      const { app, agents } = await createAgentRouteApp()
      vi.spyOn(agents, "createAgent").mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        payload: LYS_DEFINITION
      })

      expect(response.statusCode).toBe(500)
    })
  })

  describe("GET /api/v1/agents/:agentCode", () => {
    it("responds with the stored agent and its system prompt", async () => {
      const { app, agents } = await createAgentRouteApp()
      agents.createAgent(LYS_DEFINITION)

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents/lys"
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(STORED_LYS)
    })

    it("responds with the missing-agent problem", async () => {
      const { app } = await createAgentRouteApp()

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents/lys"
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(agentNotFoundProblemSchema.parse(response.json())).toMatchObject({
        detail: "Agent lys was not found.",
        instance: "/api/v1/agents/lys"
      })
    })

    it("rejects a code that is not a slug without looking it up", async () => {
      const { app, agents } = await createAgentRouteApp()
      const findAgent = vi.spyOn(agents, "findAgent")

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents/Not%20A%20Slug"
      })

      expect(response.statusCode).toBe(400)
      expect(findAgent).not.toHaveBeenCalled()
    })

    it("responds with a server error when the agent cannot be read", async () => {
      const { app, agents } = await createAgentRouteApp()
      vi.spyOn(agents, "findAgent").mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents/lys"
      })

      expect(response.statusCode).toBe(500)
    })
  })

  describe("PATCH /api/v1/agents/:agentCode", () => {
    it("replaces only the given field, trimmed, at the current time", async () => {
      const { app, agents } = await createAgentRouteApp()
      agents.createAgent(LYS_DEFINITION)
      vi.setSystemTime(new Date(LATER))
      const expected = { ...STORED_LYS, bio: "Archivist.", updatedAt: LATER }

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/lys",
        payload: { bio: "  Archivist.  " }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(expected)
      expect(agents.findAgent("lys")).toEqual(expected)
    })

    it("stores the time of a change that keeps every value", async () => {
      const { app, agents } = await createAgentRouteApp()
      agents.createAgent(LYS_DEFINITION)
      vi.setSystemTime(new Date(LATER))
      const expected = { ...STORED_LYS, updatedAt: LATER }

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/lys",
        payload: { bio: LYS_DEFINITION.bio }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(expected)
      expect(agents.findAgent("lys")).toEqual(expected)
    })

    it("stores a change that starts with a NUL character", async () => {
      const { app, agents } = await createAgentRouteApp()
      agents.createAgent(LYS_DEFINITION)

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/lys",
        payload: { bio: "\u0000Bio" }
      })

      expect(response.statusCode).toBe(200)
      expect(agents.findAgent("lys")).toMatchObject({ bio: "\u0000Bio" })
    })

    it("rejects a code that is not a slug without changing anything", async () => {
      const { app, agents } = await createAgentRouteApp()
      const updateAgent = vi.spyOn(agents, "updateAgent")

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/Not%20A%20Slug",
        payload: { bio: "Archivist." }
      })

      expect(response.statusCode).toBe(400)
      expect(updateAgent).not.toHaveBeenCalled()
    })

    it("responds with the missing-agent problem", async () => {
      const { app } = await createAgentRouteApp()

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/lys",
        payload: { name: "Lys" }
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(agentNotFoundProblemSchema.parse(response.json())).toMatchObject({
        instance: "/api/v1/agents/lys"
      })
    })

    it.each([
      ["no field", {}],
      ["a code", { code: "other" }],
      ["a blank name", { name: "  " }],
      ["a null bio", { bio: null }],
      ["a bio with a lone surrogate", { bio: "Bio\udbff" }],
      ["an unknown field", { model: "qwen/qwen3-8b" }],
      ["a name over the maximum length", { name: "n".repeat(65) }]
    ])(
      "rejects a change with %s without touching the agent",
      async (_label, payload) => {
        const { app, agents } = await createAgentRouteApp()
        agents.createAgent(LYS_DEFINITION)
        const updateAgent = vi.spyOn(agents, "updateAgent")

        const response = await app.inject({
          method: "PATCH",
          url: "/api/v1/agents/lys",
          payload
        })

        expect(response.statusCode).toBe(400)
        expect(updateAgent).not.toHaveBeenCalled()
        expect(agents.findAgent("lys")).toEqual(STORED_LYS)
      }
    )

    it("responds with a server error when the agent cannot be changed", async () => {
      const { app, agents } = await createAgentRouteApp()
      vi.spyOn(agents, "updateAgent").mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/lys",
        payload: { name: "Lys" }
      })

      expect(response.statusCode).toBe(500)
    })
  })

  describe("DELETE /api/v1/agents/:agentCode", () => {
    it("deletes the agent and responds without a body", async () => {
      const { app, agents } = await createAgentRouteApp()
      agents.createAgent(LYS_DEFINITION)

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/agents/lys"
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(agents.findAgent("lys")).toBeUndefined()
    })

    it("responds with the missing-agent problem", async () => {
      const { app } = await createAgentRouteApp()

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/agents/lys"
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(agentNotFoundProblemSchema.parse(response.json())).toMatchObject({
        instance: "/api/v1/agents/lys"
      })
    })

    it("rejects a code that is not a slug without deleting anything", async () => {
      const { app, agents } = await createAgentRouteApp()
      const deleteAgent = vi.spyOn(agents, "deleteAgent")

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/agents/LYS"
      })

      expect(response.statusCode).toBe(400)
      expect(deleteAgent).not.toHaveBeenCalled()
    })

    it("responds with a server error when the agent cannot be deleted", async () => {
      const { app, agents } = await createAgentRouteApp()
      vi.spyOn(agents, "deleteAgent").mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/agents/lys"
      })

      expect(response.statusCode).toBe(500)
    })
  })
})
