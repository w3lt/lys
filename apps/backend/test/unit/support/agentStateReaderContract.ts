import { CALIGINIA_AGENT_CODE, type AgentDefinition } from "@lys/share"
import { describe, expect, it } from "vitest"
import type { AgentIdentity } from "../../../src/modules/agent/agentRoles"
import { MAXIMUM_AGENT_SEARCH_MATCHES } from "../../../src/modules/agent/capabilities"
import type { AgentStateReader } from "../../../src/modules/agent/agentStateTools"

/** Definition of the stored agent every reader under test holds. */
export const STATE_READER_RESEARCHER = Object.freeze({
  code: "researcher",
  name: "Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web."
})

/** Definition of the stored agent every reader under test holds deleted. */
export const STATE_READER_ARCHIVIST = Object.freeze({
  code: "archivist",
  name: "Archivist",
  bio: "Keeps the records.",
  systemPrompt: "You keep the records."
})

/** Time the archivist was deleted. */
export const STATE_READER_DELETED_AT = "2026-10-20T08:00:00.000Z"

/**
 * One reader under test over the backend's built-in agents, the stored
 * {@link STATE_READER_RESEARCHER}, and the stored
 * {@link STATE_READER_ARCHIVIST}, created after the researcher and deleted at
 * {@link STATE_READER_DELETED_AT}; no agent is working on a request.
 */
export type AgentStateReaderHarness = Readonly<{
  /** Reader under test. */
  reader: AgentStateReader
  /** Request slots every agent of the reader has. */
  requestSlotCount: number
  /** Number of agent lookups and searches the reader made so far. */
  countAgentReads: () => number
  /**
   * Stores one more agent, a member, without going through the reader;
   * each agent stored later is created later.
   */
  saveAgent: (definition: AgentDefinition) => void
}>

/** Creates one reader for the current test, which releases what it holds. */
export type AgentStateReaderHarnessFactory = () => AgentStateReaderHarness

/** Caliginia, a built-in agent and so a leader. */
const LEADER: AgentIdentity = Object.freeze({
  code: CALIGINIA_AGENT_CODE,
  role: "leader"
})

/** The researcher, a stored agent and so a member. */
const MEMBER: AgentIdentity = Object.freeze({
  code: STATE_READER_RESEARCHER.code,
  role: "member"
})

/**
 * Registers the cases every {@link AgentStateReader} passes.
 *
 * @param createHarness - Creates a fresh reader for each case.
 */
export function registerAgentStateReaderContractSuite(
  createHarness: AgentStateReaderHarnessFactory
): void {
  describe("AgentStateReader contract", () => {
    it("lets a leader find agents, deleted ones included, each with the role its kind gives", () => {
      const harness = createHarness()

      const outcome = harness.reader.listAgentMatches(LEADER, "ar")

      expect(outcome).toEqual({
        status: "found",
        matches: expect.arrayContaining([
          {
            code: CALIGINIA_AGENT_CODE,
            name: "Caliginia",
            bio: "Lys's dark side.",
            role: "leader",
            deletedAt: null
          },
          {
            code: STATE_READER_RESEARCHER.code,
            name: STATE_READER_RESEARCHER.name,
            bio: STATE_READER_RESEARCHER.bio,
            role: "member",
            deletedAt: null
          },
          {
            code: STATE_READER_ARCHIVIST.code,
            name: STATE_READER_ARCHIVIST.name,
            bio: STATE_READER_ARCHIVIST.bio,
            role: "member",
            deletedAt: STATE_READER_DELETED_AT
          }
        ]),
        matchCount: 3
      })
      expect(outcome.status === "found" && outcome.matches).toHaveLength(3)
      expect(Object.isFrozen(outcome)).toBe(true)
      expect(
        outcome.status === "found" && Object.isFrozen(outcome.matches)
      ).toBe(true)
    })

    it("gives a leader only the first matches in search order and counts every match", () => {
      const harness = createHarness()
      const codes = Array.from(
        { length: MAXIMUM_AGENT_SEARCH_MATCHES + 1 },
        (_unused, index) => `scout-${String(index + 1).padStart(2, "0")}`
      )
      for (const code of codes)
        harness.saveAgent({
          code,
          name: `Scout ${code}`,
          bio: "Scouts ahead.",
          systemPrompt: "You scout ahead."
        })

      const outcome = harness.reader.listAgentMatches(LEADER, "scout")

      expect(
        outcome.status === "found" && outcome.matches.map((match) => match.code)
      ).toEqual(codes.slice(0, MAXIMUM_AGENT_SEARCH_MATCHES))
      expect(outcome).toMatchObject({ matchCount: codes.length })
    })

    it("refuses a member's search without reading any agent", () => {
      const harness = createHarness()

      expect(harness.reader.listAgentMatches(MEMBER, "ar")).toEqual({
        status: "forbidden"
      })
      expect(harness.countAgentReads()).toBe(0)
    })

    it.each([
      ["the researcher", MEMBER],
      ["a leader", LEADER]
    ])(
      "lets %s read the researcher's state while it is idle",
      (_label, reader) => {
        const harness = createHarness()

        const outcome = harness.reader.findAgentState(
          reader,
          STATE_READER_RESEARCHER.code
        )

        expect(outcome).toEqual({
          status: "found",
          state: {
            code: STATE_READER_RESEARCHER.code,
            name: STATE_READER_RESEARCHER.name,
            role: "member",
            deletedAt: null,
            requestSlotCount: harness.requestSlotCount,
            requests: []
          }
        })
        expect(Object.isFrozen(outcome)).toBe(true)
        expect(
          outcome.status === "found" && Object.isFrozen(outcome.state)
        ).toBe(true)
      }
    )

    it("lets a leader read its own state", () => {
      const harness = createHarness()

      expect(
        harness.reader.findAgentState(LEADER, CALIGINIA_AGENT_CODE)
      ).toEqual({
        status: "found",
        state: {
          code: CALIGINIA_AGENT_CODE,
          name: "Caliginia",
          role: "leader",
          deletedAt: null,
          requestSlotCount: harness.requestSlotCount,
          requests: []
        }
      })
    })

    it("tells a leader when a stored agent was deleted", () => {
      const harness = createHarness()

      expect(
        harness.reader.findAgentState(LEADER, STATE_READER_ARCHIVIST.code)
      ).toMatchObject({
        status: "found",
        state: {
          code: STATE_READER_ARCHIVIST.code,
          deletedAt: STATE_READER_DELETED_AT
        }
      })
    })

    it("answers a leader's read of a code no agent has as missing", () => {
      const harness = createHarness()

      expect(harness.reader.findAgentState(LEADER, "nobody")).toEqual({
        status: "missing"
      })
    })

    it.each([CALIGINIA_AGENT_CODE, STATE_READER_ARCHIVIST.code, "nobody"])(
      "refuses a member's read of %s without reading any agent",
      (code) => {
        const harness = createHarness()

        expect(harness.reader.findAgentState(MEMBER, code)).toEqual({
          status: "forbidden"
        })
        expect(harness.countAgentReads()).toBe(0)
      }
    )
  })
}
