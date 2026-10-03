import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import StoredAgents from "../../../../../src/di/services/agentService/agents"
import SqliteAgentRecordStore from "../../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import { parseAgentListOptions } from "../../../../../src/modules/agent/listOptions"
import { openTestDatabase } from "../../../support/conversationDatabase"

/** Time the clock reads when a case starts. */
const NOW = "2026-05-06T07:08:09.123Z"

/** Time a case moves the clock to before a later change. */
const LATER = "2026-05-07T00:00:00.000Z"

/** Definition of the agent most cases store. */
const LYS_DEFINITION = {
  code: "lys",
  name: "Lys",
  bio: "Personal assistant.",
  systemPrompt: "You are Lys."
}

/**
 * Creates the agent service over Sqlite records on an in-memory database
 * owned by the current test.
 *
 * @returns The ready service.
 */
function openStoredAgents(): StoredAgents {
  return new StoredAgents(new SqliteAgentRecordStore(openTestDatabase()))
}

describe("StoredAgents", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("createAgent", () => {
    it("stores the trimmed definition stamped with the current time", () => {
      const agents = openStoredAgents()
      const expected = { ...LYS_DEFINITION, createdAt: NOW, updatedAt: NOW }

      const created = agents.createAgent({
        ...LYS_DEFINITION,
        name: "  Lys  ",
        systemPrompt: "\nYou are Lys.\n"
      })

      expect(created).toEqual(expected)
      expect(Object.isFrozen(created)).toBe(true)
      expect(agents.findAgent("lys")).toEqual(expected)
    })

    it("returns undefined and keeps the stored agent when the code is taken", () => {
      const agents = openStoredAgents()
      const first = agents.createAgent(LYS_DEFINITION)
      vi.setSystemTime(new Date(LATER))

      expect(
        agents.createAgent({ ...LYS_DEFINITION, name: "Impostor" })
      ).toBeUndefined()

      expect(agents.findAgent("lys")).toEqual(first)
    })

    it("derives the code from the name when none is given", () => {
      const agents = openStoredAgents()

      const created = agents.createAgent({
        name: "Web Researcher",
        bio: "Searches the web.",
        systemPrompt: "You research the web."
      })

      expect(created).toMatchObject({ code: "web-researcher", createdAt: NOW })
      expect(agents.findAgent("web-researcher")).toEqual(created)
    })

    it("appends the first free number when the derived code is taken", () => {
      const agents = openStoredAgents()
      const definition = { ...LYS_DEFINITION, code: undefined }
      agents.createAgent(LYS_DEFINITION)
      agents.createAgent({ ...LYS_DEFINITION, code: "lys-2" })

      expect(agents.createAgent(definition)).toMatchObject({ code: "lys-3" })
      expect(agents.createAgent(definition)).toMatchObject({ code: "lys-4" })
    })

    it("finds a free code when the first try equals the second", () => {
      const agents = openStoredAgents()
      agents.createAgent({ ...LYS_DEFINITION, code: `${"a".repeat(62)}-2` })

      expect(
        agents.createAgent({
          ...LYS_DEFINITION,
          code: undefined,
          name: `${"a".repeat(62)} 2`
        })
      ).toMatchObject({ code: `${"a".repeat(62)}-3` })
    })

    it("derives `agent` from a name without an ASCII letter or digit", () => {
      const agents = openStoredAgents()

      expect(
        agents.createAgent({
          ...LYS_DEFINITION,
          code: undefined,
          name: "日本語"
        })
      ).toMatchObject({ code: "agent", name: "日本語" })
    })

    it("rejects an invalid definition without storing it", () => {
      const agents = openStoredAgents()

      expect(() =>
        agents.createAgent({ ...LYS_DEFINITION, code: "Lys" })
      ).toThrow(z.ZodError)

      expect(agents.findAgent("Lys")).toBeUndefined()
      expect(agents.findAgent("lys")).toBeUndefined()
    })

    it("rejects a creation time outside the stored format without storing anything", () => {
      const agents = openStoredAgents()
      vi.setSystemTime(new Date("+010000-01-01T00:00:00.000Z"))

      expect(() => agents.createAgent(LYS_DEFINITION)).toThrow(z.ZodError)

      expect(agents.findAgent("lys")).toBeUndefined()
    })
  })

  describe("findAgent", () => {
    it("returns undefined for a code no agent can have", () => {
      const agents = openStoredAgents()

      expect(agents.findAgent("Not A Slug")).toBeUndefined()
    })
  })

  describe("updateAgent", () => {
    it("stores the trimmed change at the current time and keeps the creation time", () => {
      const agents = openStoredAgents()
      agents.createAgent(LYS_DEFINITION)
      vi.setSystemTime(new Date(LATER))
      const expected = {
        ...LYS_DEFINITION,
        bio: "Archivist.",
        createdAt: NOW,
        updatedAt: LATER
      }

      expect(agents.updateAgent("lys", { bio: " Archivist. " })).toEqual(
        expected
      )

      expect(agents.findAgent("lys")).toEqual(expected)
    })

    it.each(["lys", "Not A Slug"])(
      "returns undefined for the code %s when no agent has it",
      (code) => {
        const agents = openStoredAgents()

        expect(agents.updateAgent(code, { name: "Lys" })).toBeUndefined()
        expect(agents.findAgent(code)).toBeUndefined()
      }
    )

    it.each([
      ["no field", {}],
      ["only undefined fields", { name: undefined }]
    ])(
      "rejects a change with %s without touching the agent",
      (_label, changes) => {
        const agents = openStoredAgents()
        const created = agents.createAgent(LYS_DEFINITION)
        vi.setSystemTime(new Date(LATER))

        expect(() => agents.updateAgent("lys", changes)).toThrow(z.ZodError)

        expect(agents.findAgent("lys")).toEqual(created)
      }
    )
  })

  describe("listAgents", () => {
    it("pages through agents oldest first and ends with a null cursor", () => {
      const agents = openStoredAgents()
      agents.createAgent({ ...LYS_DEFINITION, code: "b" })
      vi.setSystemTime(new Date(LATER))
      agents.createAgent({ ...LYS_DEFINITION, code: "a" })
      agents.createAgent({ ...LYS_DEFINITION, code: "c" })

      const first = agents.listAgents({ cursor: undefined, limit: 2 })
      expect(first.agents.map((agent) => agent.code)).toEqual(["b", "a"])
      expect(first).toMatchObject({
        storedCount: 3,
        nextCursor: expect.any(String)
      })

      const second = agents.listAgents(
        parseAgentListOptions({ cursor: first.nextCursor ?? "", limit: 2 })
      )
      expect(second.agents.map((agent) => agent.code)).toEqual(["c"])
      expect(second).toMatchObject({ storedCount: 3, nextCursor: null })
    })

    it("lists each agent created in the same millisecond exactly once", () => {
      const agents = openStoredAgents()
      for (const code of ["c", "a", "b"])
        agents.createAgent({ ...LYS_DEFINITION, code })

      const first = agents.listAgents({ cursor: undefined, limit: 1 })
      const second = agents.listAgents(
        parseAgentListOptions({ cursor: first.nextCursor ?? "", limit: 1 })
      )
      const third = agents.listAgents(
        parseAgentListOptions({ cursor: second.nextCursor ?? "", limit: 1 })
      )

      expect(
        [first, second, third].flatMap((page) =>
          page.agents.map((agent) => agent.code)
        )
      ).toEqual(["a", "b", "c"])
      expect(third.nextCursor).toBeNull()
    })

    it("returns an empty final page when no agent is stored", () => {
      const agents = openStoredAgents()

      expect(agents.listAgents({ cursor: undefined, limit: 30 })).toEqual({
        agents: [],
        storedCount: 0,
        nextCursor: null
      })
    })
  })

  describe("deleteAgent", () => {
    it("deletes a stored agent once", () => {
      const agents = openStoredAgents()
      agents.createAgent(LYS_DEFINITION)

      expect(agents.deleteAgent("lys")).toBe(true)
      expect(agents.findAgent("lys")).toBeUndefined()
      expect(agents.deleteAgent("lys")).toBe(false)
    })
  })
})
