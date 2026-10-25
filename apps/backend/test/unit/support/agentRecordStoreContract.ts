import { describe, expect, it } from "vitest"
import type { AgentSummary } from "@lys/protocol"
import type { Agent } from "@lys/share"
import type {
  AgentRecordSearcher,
  AgentRecordStore,
  StoredAgentMatch,
  StoredAgentRecord
} from "../../../src/modules/agent/records"

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

/**
 * Agent records and their search over one empty store, with the controls a
 * case needs.
 */
export type AgentRecordSearcherHarness = AgentRecordStoreHarness &
  Readonly<{
    /** Search over the same store; the records save what a case finds. */
    recordSearcher: AgentRecordSearcher
  }>

/**
 * Creates the records and their search over one empty store owned by the
 * current test, which closes the store when it finishes.
 */
export type AgentRecordSearcherHarnessFactory = () => AgentRecordSearcherHarness

/** Creation time of stored fixtures. */
const CREATED_AT = "2026-01-02T03:04:05.678Z"

/** Time a case passes as the moment of its change. */
const CHANGED_AT = "2026-02-03T04:05:06.789Z"

/** Last-change time of the second agent, after its creation time. */
const RESEARCHER_CHANGED_AT = "2026-01-20T00:00:00.000Z"

/** Agent most cases store and address. */
const LYS: Agent = Object.freeze({
  code: "lys",
  name: "Lys",
  bio: "Personal assistant.",
  systemPrompt: "You are Lys.",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT
})

/**
 * Second agent, last changed after its creation; used to prove that both
 * times are stored as given and that a change stays with its agent.
 */
const RESEARCHER: Agent = Object.freeze({
  code: "web-researcher",
  name: "Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web.",
  createdAt: CREATED_AT,
  updatedAt: RESEARCHER_CHANGED_AT
})

/** Time a case passes as the moment an agent is deleted. */
const DELETED_AT = "2026-03-04T05:06:07.890Z"

/**
 * Builds the record of a stored agent that is not deleted.
 *
 * @param agent - Stored agent.
 * @returns The record the store reads for it.
 */
function buildKeptRecord(agent: Agent): StoredAgentRecord {
  return { agent, deletedAt: null }
}

/**
 * Builds the search match of a stored agent.
 *
 * @param agent - Stored agent.
 * @param match - Its deletion time and whether its code or name equals the
 * query.
 * @returns The match the store reads for it, without the system prompt.
 */
function buildMatch(
  agent: Agent,
  match: Readonly<{ deletedAt: string | null; isExactMatch: boolean }>
): StoredAgentMatch {
  const summary: AgentSummary = {
    code: agent.code,
    name: agent.name,
    bio: agent.bio,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  }
  return { agent: summary, ...match }
}

/** Earlier creation time shared by two listed agents. */
const FIRST_CREATED_AT = "2026-01-01T00:00:00.000Z"

/** Later creation time of one listed agent. */
const SECOND_CREATED_AT = "2026-01-01T00:00:00.001Z"

/** Last-change time of listed agent `c`, after every listed creation time. */
const LISTED_CHANGED_AT = "2026-01-01T00:00:00.002Z"

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
 * Saves three agents that creation time alone does not order: `b` and `c`
 * share the earlier time, and `a`, created later, sorts last. `c` was last
 * changed after `a` was created, so ordering by change time would move it
 * last.
 *
 * @param recordStore - Records over an empty store.
 */
function saveListedAgents(recordStore: AgentRecordStore): void {
  recordStore.createAgent(createListedAgent("a", SECOND_CREATED_AT))
  recordStore.createAgent({
    ...createListedAgent("c", FIRST_CREATED_AT),
    updatedAt: LISTED_CHANGED_AT
  })
  recordStore.createAgent(createListedAgent("b", FIRST_CREATED_AT))
}

/** Creation time of agents stored after the listed ones. */
const LATER_CREATED_AT = "2026-01-01T00:00:01.000Z"

/**
 * Agent created after the listed ones whose name equals the query `Agent`
 * in another case.
 */
const NAMED_AGENT: Agent = Object.freeze({
  code: "helper",
  name: "agent",
  bio: "Helps.",
  systemPrompt: "You help.",
  createdAt: LATER_CREATED_AT,
  updatedAt: LATER_CREATED_AT
})

/**
 * Agent created with {@link NAMED_AGENT} whose code equals the query `Agent`
 * in another case; its code sorts first among the two.
 */
const CODED_AGENT: Agent = Object.freeze({
  code: "agent",
  name: "Zed",
  bio: "Waits.",
  systemPrompt: "You wait.",
  createdAt: LATER_CREATED_AT,
  updatedAt: LATER_CREATED_AT
})

/**
 * Saves the listed agents, each named `Agent <code>`, and then
 * {@link NAMED_AGENT} and {@link CODED_AGENT}, so the query `Agent` matches
 * all five and equals only the last two.
 *
 * @param recordStore - Records over an empty store.
 */
function saveSearchedAgents(recordStore: AgentRecordStore): void {
  saveListedAgents(recordStore)
  recordStore.createAgent(NAMED_AGENT)
  recordStore.createAgent(CODED_AGENT)
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
        saveListedAgents(recordStore)

        const page = recordStore.listAgents({ after: undefined, limit: 3 })

        expect(page.agents.map((agent) => agent.code)).toEqual(["b", "c", "a"])
        expect(page.agents[0]).toEqual({
          code: "b",
          name: "Agent b",
          bio: "Bio of b.",
          createdAt: FIRST_CREATED_AT,
          updatedAt: FIRST_CREATED_AT
        })
        expect(page.agents[1]).toEqual({
          code: "c",
          name: "Agent c",
          bio: "Bio of c.",
          createdAt: FIRST_CREATED_AT,
          updatedAt: LISTED_CHANGED_AT
        })
        expect(page).toMatchObject({ storedCount: 3, hasMore: false })
        expect(Object.isFrozen(page.agents[0])).toBe(true)
      })

      it("stops at the limit and reports that more agents follow", () => {
        const { recordStore } = createHarness()
        saveListedAgents(recordStore)

        const page = recordStore.listAgents({ after: undefined, limit: 2 })

        expect(page.agents.map((agent) => agent.code)).toEqual(["b", "c"])
        expect(page).toMatchObject({ storedCount: 3, hasMore: true })
      })

      it("continues after the boundary agent, counting every stored agent", () => {
        const { recordStore } = createHarness()
        saveListedAgents(recordStore)

        const page = recordStore.listAgents({
          after: { createdAt: FIRST_CREATED_AT, code: "c" },
          limit: 2
        })

        expect(page.agents.map((agent) => agent.code)).toEqual(["a"])
        expect(page).toMatchObject({ storedCount: 3, hasMore: false })
      })

      it("continues within agents created at the same time by code", () => {
        const { recordStore } = createHarness()
        saveListedAgents(recordStore)

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
        recordStore.createAgent(RESEARCHER)

        const found = recordStore.findAgent("web-researcher")

        expect(found).toEqual(buildKeptRecord(RESEARCHER))
        expect(Object.isFrozen(found)).toBe(true)
        expect(Object.isFrozen(found?.agent)).toBe(true)
      })

      it("returns a deleted agent with the time it was deleted", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(RESEARCHER)
        recordStore.deleteAgent("web-researcher", DELETED_AT)

        expect(recordStore.findAgent("web-researcher")).toEqual({
          agent: RESEARCHER,
          deletedAt: DELETED_AT
        })
      })
    })

    describe("createAgent", () => {
      it("stores a new agent and reports it stored", () => {
        const { recordStore } = createHarness()

        expect(recordStore.createAgent(LYS)).toBe(true)
        expect(recordStore.createAgent(RESEARCHER)).toBe(true)

        expect(recordStore.findAgent("web-researcher")).toEqual(
          buildKeptRecord(RESEARCHER)
        )
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

        expect(recordStore.findAgent("lys")).toEqual(buildKeptRecord(LYS))
      })

      it("reports false and keeps the deleted agent when the code is a deleted agent's", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        recordStore.deleteAgent("lys", DELETED_AT)

        expect(
          recordStore.createAgent({
            ...RESEARCHER,
            code: "lys",
            createdAt: CHANGED_AT,
            updatedAt: CHANGED_AT
          })
        ).toBe(false)

        expect(recordStore.findAgent("lys")).toEqual({
          agent: LYS,
          deletedAt: DELETED_AT
        })
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
        expect(recordStore.findAgent("lys")).toEqual(buildKeptRecord(expected))
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

      it("stores the change time even when the given values equal the stored ones", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        const expected = { ...LYS, updatedAt: CHANGED_AT }

        expect(
          recordStore.updateAgent({
            code: "lys",
            changes: { bio: LYS.bio },
            updatedAt: CHANGED_AT
          })
        ).toEqual(expected)

        expect(recordStore.findAgent("lys")).toEqual(buildKeptRecord(expected))
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

        expect(recordStore.findAgent("web-researcher")).toEqual(
          buildKeptRecord(RESEARCHER)
        )
      })

      it("returns undefined and changes nothing for a deleted agent", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        recordStore.deleteAgent("lys", DELETED_AT)

        expect(
          recordStore.updateAgent({
            code: "lys",
            changes: { name: "Lysiptera" },
            updatedAt: CHANGED_AT
          })
        ).toBeUndefined()

        expect(recordStore.findAgent("lys")).toEqual({
          agent: LYS,
          deletedAt: DELETED_AT
        })
      })
    })

    describe("deleteAgent", () => {
      it("marks a stored agent deleted at the given time and reports true, keeping its fields and other agents", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        recordStore.createAgent(RESEARCHER)

        expect(recordStore.deleteAgent("lys", DELETED_AT)).toBe(true)

        expect(recordStore.findAgent("lys")).toEqual({
          agent: LYS,
          deletedAt: DELETED_AT
        })
        expect(recordStore.findAgent("web-researcher")).toEqual(
          buildKeptRecord(RESEARCHER)
        )
      })

      it("reports false and keeps the first deletion time for a deleted agent", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        recordStore.deleteAgent("lys", DELETED_AT)

        expect(recordStore.deleteAgent("lys", CHANGED_AT)).toBe(false)

        expect(recordStore.findAgent("lys")?.deletedAt).toBe(DELETED_AT)
      })

      it("reports false for a code that is not stored", () => {
        const { recordStore } = createHarness()

        expect(recordStore.deleteAgent("lys", DELETED_AT)).toBe(false)
      })

      it("leaves a deleted agent out of every list page and the stored count", () => {
        const { recordStore } = createHarness()
        saveListedAgents(recordStore)
        recordStore.deleteAgent("c", DELETED_AT)

        const page = recordStore.listAgents({ after: undefined, limit: 3 })

        expect(page.agents.map((agent) => agent.code)).toEqual(["b", "a"])
        expect(page.storedCount).toBe(2)
        expect(page.hasMore).toBe(false)
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
      expect(() => recordStore.deleteAgent("lys", DELETED_AT)).toThrow(
        "Database is closed"
      )
    })
  })
}

/**
 * Registers the provider-independent {@link AgentRecordSearcher} contract
 * cases.
 *
 * @param createHarness - Creates the records and their search over one empty
 * store per case.
 */
export function registerAgentRecordSearcherContractSuite(
  createHarness: AgentRecordSearcherHarnessFactory
): void {
  describe("AgentRecordSearcher contract", () => {
    it("matches the code, the name, or the bio, ignoring case", () => {
      const { recordStore, recordSearcher } = createHarness()
      recordStore.createAgent(LYS)
      recordStore.createAgent(RESEARCHER)

      expect(
        recordSearcher.searchAgents({ query: "RESEARCH", limit: 20 })
      ).toEqual({
        matches: [
          buildMatch(RESEARCHER, { deletedAt: null, isExactMatch: false })
        ],
        matchCount: 1
      })
      expect(
        recordSearcher.searchAgents({ query: "assistant", limit: 20 }).matches
      ).toEqual([buildMatch(LYS, { deletedAt: null, isExactMatch: false })])
    })

    it("takes the query literally", () => {
      const { recordStore, recordSearcher } = createHarness()
      recordStore.createAgent(createListedAgent("abc", FIRST_CREATED_AT))

      expect(recordSearcher.searchAgents({ query: "a.c", limit: 20 })).toEqual({
        matches: [],
        matchCount: 0
      })
    })

    it("includes a deleted agent with the time it was deleted", () => {
      const { recordStore, recordSearcher } = createHarness()
      recordStore.createAgent(RESEARCHER)
      recordStore.deleteAgent("web-researcher", DELETED_AT)

      expect(
        recordSearcher.searchAgents({ query: "researcher", limit: 20 })
      ).toEqual({
        matches: [
          buildMatch(RESEARCHER, {
            deletedAt: DELETED_AT,
            isExactMatch: true
          })
        ],
        matchCount: 1
      })
    })

    it("puts code and name matches equal to the query first, then the others, each by creation time and code", () => {
      const { recordStore, recordSearcher } = createHarness()
      saveSearchedAgents(recordStore)

      const page = recordSearcher.searchAgents({ query: "Agent", limit: 20 })

      expect(
        page.matches.map((match) => [match.agent.code, match.isExactMatch])
      ).toEqual([
        ["agent", true],
        ["helper", true],
        ["b", false],
        ["c", false],
        ["a", false]
      ])
      expect(page.matchCount).toBe(5)
    })

    it("does not count a bio equal to the query as an exact match", () => {
      const { recordStore, recordSearcher } = createHarness()
      recordStore.createAgent({ ...RESEARCHER, bio: "Researcher web" })

      expect(
        recordSearcher.searchAgents({ query: "researcher web", limit: 20 })
          .matches
      ).toEqual([
        buildMatch(
          { ...RESEARCHER, bio: "Researcher web" },
          { deletedAt: null, isExactMatch: false }
        )
      ])
    })

    it("compares a name that contains NUL whole when it looks for an exact match", () => {
      const { recordStore, recordSearcher } = createHarness()
      const agent = { ...RESEARCHER, name: "Res\u0000earcher" }
      recordStore.createAgent(agent)

      expect(
        recordSearcher.searchAgents({ query: "res", limit: 20 }).matches
      ).toEqual([buildMatch(agent, { deletedAt: null, isExactMatch: false })])
      expect(
        recordSearcher.searchAgents({ query: "RES\u0000EARCHER", limit: 20 })
          .matches
      ).toEqual([buildMatch(agent, { deletedAt: null, isExactMatch: true })])
    })

    it("cuts the ordered matches at the limit and still counts every match", () => {
      const { recordStore, recordSearcher } = createHarness()
      saveSearchedAgents(recordStore)

      const page = recordSearcher.searchAgents({ query: "agent", limit: 2 })

      expect(page.matches.map((match) => match.agent.code)).toEqual([
        "agent",
        "helper"
      ])
      expect(page.matchCount).toBe(5)
    })

    it("returns a frozen page", () => {
      const { recordStore, recordSearcher } = createHarness()
      recordStore.createAgent(RESEARCHER)

      const page = recordSearcher.searchAgents({ query: "web", limit: 20 })

      expect(Object.isFrozen(page)).toBe(true)
      expect(Object.isFrozen(page.matches)).toBe(true)
      expect(Object.isFrozen(page.matches[0])).toBe(true)
      expect(Object.isFrozen(page.matches[0]?.agent)).toBe(true)
    })

    it("fails with `Database is closed` after the owner closes the store", () => {
      const { recordStore, recordSearcher, closeRecords } = createHarness()
      recordStore.createAgent(LYS)
      closeRecords()

      expect(() =>
        recordSearcher.searchAgents({ query: "lys", limit: 1 })
      ).toThrow("Database is closed")
    })
  })
}
