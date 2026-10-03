import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import StoredAgents from "../../../../../src/di/services/agentService/agents"
import SqliteAgentRecordStore from "../../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
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

    it("rejects an invalid definition without storing it", () => {
      const agents = openStoredAgents()

      expect(() =>
        agents.createAgent({ ...LYS_DEFINITION, code: "Lys" })
      ).toThrow(z.ZodError)

      expect(agents.findAgent("Lys")).toBeUndefined()
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

      expect(agents.updateAgent({ code: "lys", bio: " Archivist. " })).toEqual(
        expected
      )

      expect(agents.findAgent("lys")).toEqual(expected)
    })

    it("returns undefined for an agent that is not stored", () => {
      const agents = openStoredAgents()

      expect(agents.updateAgent({ code: "lys", name: "Lys" })).toBeUndefined()
      expect(agents.findAgent("lys")).toBeUndefined()
    })

    it("rejects an update that changes no field without touching the agent", () => {
      const agents = openStoredAgents()
      const created = agents.createAgent(LYS_DEFINITION)
      vi.setSystemTime(new Date(LATER))

      expect(() => agents.updateAgent({ code: "lys" })).toThrow(z.ZodError)

      expect(agents.findAgent("lys")).toEqual(created)
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
