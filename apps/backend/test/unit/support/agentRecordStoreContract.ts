import { describe, expect, it } from "vitest"
import type { Agent } from "@lys/share"
import type { AgentRecordStore } from "../../../src/di/services/agentService/records"

/** Agent records over one empty store, with the controls a case needs. */
export type AgentRecordStoreHarness = Readonly<{
  /** Agent records over the store. */
  recordStore: AgentRecordStore
  /** Closes the store as its owner does; a repeated call changes nothing. */
  closeRecords: () => void
}>

/**
 * Creates the records over one empty store owned by the current test, which
 * closes the store when it finishes.
 */
export type AgentRecordStoreHarnessFactory = () => AgentRecordStoreHarness

/** Creation time of stored fixtures. */
const CREATED_AT = "2026-01-02T03:04:05.678Z"

/** Time a case passes as the moment of its change. */
const CHANGED_AT = "2026-02-03T04:05:06.789Z"

/** Agent most cases store and address. */
const LYS: Agent = Object.freeze({
  code: "lys",
  name: "Lys",
  bio: "Personal assistant.",
  systemPrompt: "You are Lys.",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT
})

/** Second agent, used to prove a change stays with its agent. */
const RESEARCHER: Agent = Object.freeze({
  code: "web-researcher",
  name: "Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web.",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT
})

/** Earlier creation time shared by two listed agents. */
const FIRST_CREATED_AT = "2026-01-01T00:00:00.000Z"

/** Later creation time of one listed agent. */
const SECOND_CREATED_AT = "2026-01-01T00:00:00.001Z"

/**
 * Creates a valid agent whose code and creation time decide its list position.
 *
 * @param code - Code of the agent.
 * @param createdAt - Creation and last-change time.
 * @returns The frozen agent.
 */
function createListedAgent(code: string, createdAt: string): Agent {
  return Object.freeze({
    code,
    name: `Agent ${code}`,
    bio: `Bio of ${code}.`,
    systemPrompt: `You are agent ${code}.`,
    createdAt,
    updatedAt: createdAt
  })
}

/**
 * Stores three agents that creation time alone does not order: `b` and `c`
 * share the earlier time, and `a`, created later, sorts last.
 *
 * @param recordStore - Records over an empty store.
 */
function storeListedAgents(recordStore: AgentRecordStore): void {
  recordStore.createAgent(createListedAgent("a", SECOND_CREATED_AT))
  recordStore.createAgent(createListedAgent("c", FIRST_CREATED_AT))
  recordStore.createAgent(createListedAgent("b", FIRST_CREATED_AT))
}

/**
 * Registers the provider-independent {@link AgentRecordStore} contract cases.
 *
 * @param createHarness - Creates the records over one empty store per case.
 */
export function registerAgentRecordStoreContractSuite(
  createHarness: AgentRecordStoreHarnessFactory
): void {
  describe("AgentRecordStore contract", () => {
    describe("listAgents", () => {
      it("returns an empty first page for an empty store", () => {
        const { recordStore } = createHarness()

        expect(recordStore.listAgents({ after: undefined, limit: 2 })).toEqual({
          agents: [],
          storedCount: 0,
          hasMore: false
        })
      })

      it("lists summaries by creation time, then code, without system prompts", () => {
        const { recordStore } = createHarness()
        storeListedAgents(recordStore)

        const page = recordStore.listAgents({ after: undefined, limit: 3 })

        expect(page.agents.map((agent) => agent.code)).toEqual(["b", "c", "a"])
        expect(page.agents[0]).toEqual({
          code: "b",
          name: "Agent b",
          bio: "Bio of b.",
          createdAt: FIRST_CREATED_AT,
          updatedAt: FIRST_CREATED_AT
        })
        expect(page).toMatchObject({ storedCount: 3, hasMore: false })
        expect(Object.isFrozen(page.agents[0])).toBe(true)
      })

      it("stops at the limit and reports that more agents follow", () => {
        const { recordStore } = createHarness()
        storeListedAgents(recordStore)

        const page = recordStore.listAgents({ after: undefined, limit: 2 })

        expect(page.agents.map((agent) => agent.code)).toEqual(["b", "c"])
        expect(page).toMatchObject({ storedCount: 3, hasMore: true })
      })

      it("continues after the boundary agent, counting every stored agent", () => {
        const { recordStore } = createHarness()
        storeListedAgents(recordStore)

        const page = recordStore.listAgents({
          after: { createdAt: FIRST_CREATED_AT, code: "c" },
          limit: 2
        })

        expect(page.agents.map((agent) => agent.code)).toEqual(["a"])
        expect(page).toMatchObject({ storedCount: 3, hasMore: false })
      })

      it("continues within agents created at the same time by code", () => {
        const { recordStore } = createHarness()
        storeListedAgents(recordStore)

        const page = recordStore.listAgents({
          after: { createdAt: FIRST_CREATED_AT, code: "b" },
          limit: 2
        })

        expect(page.agents.map((agent) => agent.code)).toEqual(["c", "a"])
      })
    })

    describe("findAgent", () => {
      it("returns undefined for a code that is not stored", () => {
        const { recordStore } = createHarness()

        expect(recordStore.findAgent("lys")).toBeUndefined()
      })

      it("returns the stored agent exactly as created, frozen", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)

        const found = recordStore.findAgent("lys")

        expect(found).toEqual(LYS)
        expect(Object.isFrozen(found)).toBe(true)
      })
    })

    describe("createAgent", () => {
      it("stores a new agent and reports it stored", () => {
        const { recordStore } = createHarness()

        expect(recordStore.createAgent(LYS)).toBe(true)
        expect(recordStore.createAgent(RESEARCHER)).toBe(true)

        expect(recordStore.findAgent("web-researcher")).toEqual(RESEARCHER)
      })

      it("keeps the stored agent and reports false when the code is taken", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)

        expect(
          recordStore.createAgent({
            ...RESEARCHER,
            code: "lys",
            createdAt: CHANGED_AT,
            updatedAt: CHANGED_AT
          })
        ).toBe(false)

        expect(recordStore.findAgent("lys")).toEqual(LYS)
      })
    })

    describe("updateAgent", () => {
      it("replaces only the given field and stores the change time", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        const expected = { ...LYS, bio: "Archivist.", updatedAt: CHANGED_AT }

        const updated = recordStore.updateAgent({
          code: "lys",
          changes: { bio: "Archivist." },
          updatedAt: CHANGED_AT
        })

        expect(updated).toEqual(expected)
        expect(Object.isFrozen(updated)).toBe(true)
        expect(recordStore.findAgent("lys")).toEqual(expected)
      })

      it("replaces every field given together", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)

        expect(
          recordStore.updateAgent({
            code: "lys",
            changes: {
              name: "Lysiptera",
              bio: "Archivist.",
              systemPrompt: "You keep the archive."
            },
            updatedAt: CHANGED_AT
          })
        ).toEqual({
          code: "lys",
          name: "Lysiptera",
          bio: "Archivist.",
          systemPrompt: "You keep the archive.",
          createdAt: CREATED_AT,
          updatedAt: CHANGED_AT
        })
      })

      it("returns undefined and stores nothing for a code that is not stored", () => {
        const { recordStore } = createHarness()

        expect(
          recordStore.updateAgent({
            code: "lys",
            changes: { name: "Lys" },
            updatedAt: CHANGED_AT
          })
        ).toBeUndefined()

        expect(recordStore.findAgent("lys")).toBeUndefined()
      })

      it("leaves other agents unchanged", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        recordStore.createAgent(RESEARCHER)

        recordStore.updateAgent({
          code: "lys",
          changes: { name: "Lysiptera" },
          updatedAt: CHANGED_AT
        })

        expect(recordStore.findAgent("web-researcher")).toEqual(RESEARCHER)
      })
    })

    describe("deleteAgent", () => {
      it("deletes a stored agent and reports true, keeping other agents", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        recordStore.createAgent(RESEARCHER)

        expect(recordStore.deleteAgent("lys")).toBe(true)

        expect(recordStore.findAgent("lys")).toBeUndefined()
        expect(recordStore.findAgent("web-researcher")).toEqual(RESEARCHER)
      })

      it("reports false for a code that is not stored", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        recordStore.deleteAgent("lys")

        expect(recordStore.deleteAgent("lys")).toBe(false)
      })
    })

    it("fails every operation with `Database is closed` after the owner closes the store", () => {
      const { recordStore, closeRecords } = createHarness()
      recordStore.createAgent(LYS)
      closeRecords()

      expect(() => recordStore.findAgent("lys")).toThrow("Database is closed")
      expect(() => recordStore.createAgent(RESEARCHER)).toThrow(
        "Database is closed"
      )
      expect(() =>
        recordStore.updateAgent({
          code: "lys",
          changes: { name: "Lys" },
          updatedAt: CHANGED_AT
        })
      ).toThrow("Database is closed")
      expect(() =>
        recordStore.listAgents({ after: undefined, limit: 1 })
      ).toThrow("Database is closed")
      expect(() => recordStore.deleteAgent("lys")).toThrow("Database is closed")
    })
  })
}
