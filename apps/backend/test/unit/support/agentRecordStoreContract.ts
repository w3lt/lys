import { describe, expect, it } from "vitest"
import type { AgentRecordStore } from "../../../src/di/services/agentService/records"
import type { Agent } from "../../../src/modules/agent/agent"

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

/**
 * Registers the provider-independent {@link AgentRecordStore} contract cases.
 *
 * @param createHarness - Creates the records over one empty store per case.
 */
export function registerAgentRecordStoreContractSuite(
  createHarness: AgentRecordStoreHarnessFactory
): void {
  describe("AgentRecordStore contract", () => {
    describe("findAgent", () => {
      it("returns undefined for a code that is not stored", () => {
        const { recordStore } = createHarness()

        expect(recordStore.findAgent("lys")).toBeUndefined()
      })

      it("returns the stored agent exactly as created", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)

        expect(recordStore.findAgent("lys")).toEqual(LYS)
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
        const updated = { ...LYS, bio: "Archivist.", updatedAt: CHANGED_AT }

        expect(
          recordStore.updateAgent(
            { code: "lys", bio: "Archivist." },
            CHANGED_AT
          )
        ).toEqual(updated)

        expect(recordStore.findAgent("lys")).toEqual(updated)
      })

      it("replaces every field given together", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)

        expect(
          recordStore.updateAgent(
            {
              code: "lys",
              name: "Lysiptera",
              bio: "Archivist.",
              systemPrompt: "You keep the archive."
            },
            CHANGED_AT
          )
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
          recordStore.updateAgent({ code: "lys", name: "Lys" }, CHANGED_AT)
        ).toBeUndefined()

        expect(recordStore.findAgent("lys")).toBeUndefined()
      })

      it("leaves other agents unchanged", () => {
        const { recordStore } = createHarness()
        recordStore.createAgent(LYS)
        recordStore.createAgent(RESEARCHER)

        recordStore.updateAgent({ code: "lys", name: "Lysiptera" }, CHANGED_AT)

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
        recordStore.updateAgent({ code: "lys", name: "Lys" }, CHANGED_AT)
      ).toThrow("Database is closed")
      expect(() => recordStore.deleteAgent("lys")).toThrow("Database is closed")
    })
  })
}
