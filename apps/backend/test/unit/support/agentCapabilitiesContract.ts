import type { BuiltInAgentSummary, ListAgentsApiResponse } from "@lys/protocol"
import type { Agent, BuiltInAgent } from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import type {
  AgentDeleter,
  AgentEditor,
  AgentLister,
  AgentReader
} from "../../../src/modules/agent/capabilities"
import { parseAgentListOptions } from "../../../src/modules/agent/listOptions"

/**
 * Agent listing, lookup, change, and deletion over one store holding no
 * agent, with the controls a case needs.
 */
export type AgentCapabilitiesHarness = Readonly<{
  /** Agent listing under test. */
  agentLister: AgentLister
  /** Agent lookup under test. */
  agentReader: AgentReader
  /** Agent change under test. */
  agentEditor: AgentEditor
  /** Agent deletion under test. */
  agentDeleter: AgentDeleter
  /** Built-in agents the capabilities ship, in the order they are listed. */
  builtInAgents: readonly BuiltInAgent[]
  /**
   * Stores one valid agent exactly as given, without going through a
   * capability under test.
   */
  saveAgent: (agent: Agent) => void
  /**
   * Stores, under the given code, one agent that violates the agent contract,
   * as a damaged store holds.
   */
  saveInvalidAgent: (code: string) => void
  /**
   * Reads every agent the store holds, in code order, without going through
   * a capability under test.
   */
  readStoredAgents: () => readonly Agent[]
  /**
   * Makes every later attempt to change or delete a stored agent fail with an
   * error whose message is `message`, as a failing disk does; the store stays
   * readable.
   */
  failAgentWrites: (message: string) => void
  /** Closes the store as its owner does. */
  closeStore: () => void
}>

/**
 * Creates the capabilities over one store holding no agent, owned by the
 * current test, which closes the store when it finishes.
 */
export type AgentCapabilitiesHarnessFactory = () => AgentCapabilitiesHarness

/** Earlier creation time, shared by two listed agents. */
const FIRST_CREATED_AT = "2026-01-01T00:00:00.000Z"

/** Later creation time of one listed agent. */
const SECOND_CREATED_AT = "2026-01-01T00:00:00.001Z"

/** Stored agent most cases address. */
const RESEARCHER: Agent = Object.freeze({
  code: "researcher",
  name: "Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web.",
  createdAt: FIRST_CREATED_AT,
  updatedAt: FIRST_CREATED_AT
})

/** Second stored agent, used to prove a change stays with its agent. */
const ARCHIVIST: Agent = Object.freeze({
  code: "archivist",
  name: "Archivist",
  bio: "Keeps the records.",
  systemPrompt: "You keep the records.",
  createdAt: SECOND_CREATED_AT,
  updatedAt: SECOND_CREATED_AT
})

/** Codes no built-in or stored agent has in any case. */
const ABSENT_AGENT_CODES: readonly string[] = Object.freeze([
  "Not A Slug",
  "lys",
  "writer"
])

/** Message of the write failure that cases induce. */
const AGENT_WRITE_FAILURE_MESSAGE = "Agent write failed"

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
 * share the earlier time, and `a`, created later, is listed last.
 *
 * @param harness - Capabilities over an empty store.
 */
function saveListedAgents(harness: AgentCapabilitiesHarness): void {
  harness.saveAgent(createListedAgent("a", SECOND_CREATED_AT))
  harness.saveAgent(createListedAgent("c", FIRST_CREATED_AT))
  harness.saveAgent(createListedAgent("b", FIRST_CREATED_AT))
}

/**
 * Builds the summary a list page carries for one built-in agent.
 *
 * @param agent - Built-in agent as shipped.
 * @returns The agent without its system prompt.
 */
function buildBuiltInAgentSummary(agent: BuiltInAgent): BuiltInAgentSummary {
  return { code: agent.code, name: agent.name, bio: agent.bio }
}

/**
 * Lists the page that follows another page.
 *
 * @param agentLister - Agent listing under test.
 * @param page - Page that more agents follow.
 * @returns The next page, of at most two agents.
 * @throws If `page` is the final page.
 */
function listFollowingAgents(
  agentLister: AgentLister,
  page: ListAgentsApiResponse
): ListAgentsApiResponse {
  if (page.nextCursor === null)
    throw new Error("Expected a page that more agents follow")
  return agentLister.listAgents(
    parseAgentListOptions({ cursor: page.nextCursor, limit: 2 })
  )
}

/**
 * Registers the provider-independent {@link AgentLister} contract cases.
 *
 * @param createHarness - Creates the capabilities over one empty store per
 * case.
 */
export function registerAgentListerContractSuite(
  createHarness: AgentCapabilitiesHarnessFactory
): void {
  describe("AgentLister contract", () => {
    it("returns an empty final page with every built-in agent when no agent is stored", () => {
      const { agentLister, builtInAgents } = createHarness()

      expect(agentLister.listAgents({ cursor: undefined, limit: 2 })).toEqual({
        builtInAgents: builtInAgents.map(buildBuiltInAgentSummary),
        agents: [],
        storedCount: 0,
        nextCursor: null
      })
    })

    it("lists stored agents by creation time, then code, without system prompts", () => {
      const harness = createHarness()
      saveListedAgents(harness)

      const page = harness.agentLister.listAgents({
        cursor: undefined,
        limit: 3
      })

      expect(page.agents.map((agent) => agent.code)).toEqual(["b", "c", "a"])
      expect(page.agents[0]).toEqual({
        code: "b",
        name: "Agent b",
        bio: "Bio of b.",
        createdAt: FIRST_CREATED_AT,
        updatedAt: FIRST_CREATED_AT
      })
      expect(page).toMatchObject({ storedCount: 3, nextCursor: null })
    })

    it("continues after a page's cursor until a null cursor ends the listing", () => {
      const harness = createHarness()
      saveListedAgents(harness)

      const first = harness.agentLister.listAgents({
        cursor: undefined,
        limit: 2
      })
      const second = listFollowingAgents(harness.agentLister, first)

      expect(first.agents.map((agent) => agent.code)).toEqual(["b", "c"])
      expect(first).toMatchObject({
        storedCount: 3,
        nextCursor: expect.any(String)
      })
      expect(second.agents.map((agent) => agent.code)).toEqual(["a"])
      expect(second).toMatchObject({ storedCount: 3, nextCursor: null })
    })

    it("carries every built-in agent on every page, in shipped order and without system prompts", () => {
      const harness = createHarness()
      saveListedAgents(harness)
      const summaries = harness.builtInAgents.map(buildBuiltInAgentSummary)

      const first = harness.agentLister.listAgents({
        cursor: undefined,
        limit: 2
      })
      const second = listFollowingAgents(harness.agentLister, first)

      expect(first.builtInAgents).toEqual(summaries)
      expect(second.builtInAgents).toEqual(summaries)
    })

    it("fails when the store holds an invalid agent", () => {
      const { agentLister, saveInvalidAgent } = createHarness()
      saveInvalidAgent("damaged")

      expect(() =>
        agentLister.listAgents({ cursor: undefined, limit: 2 })
      ).toThrow(z.ZodError)
    })

    it("fails with `Database is closed` after the owner closes the store", () => {
      const { agentLister, closeStore } = createHarness()
      closeStore()

      expect(() =>
        agentLister.listAgents({ cursor: undefined, limit: 2 })
      ).toThrow("Database is closed")
    })
  })
}

/**
 * Registers the provider-independent {@link AgentReader} contract cases.
 *
 * @param createHarness - Creates the capabilities over one empty store per
 * case.
 */
export function registerAgentReaderContractSuite(
  createHarness: AgentCapabilitiesHarnessFactory
): void {
  describe("AgentReader contract", () => {
    it.each(ABSENT_AGENT_CODES)(
      "returns undefined for the code %s, which no agent has",
      (code) => {
        const { agentReader, saveAgent } = createHarness()
        saveAgent(RESEARCHER)

        expect(agentReader.findAgent(code)).toBeUndefined()
      }
    )

    it("finds every built-in agent with its shipped system prompt, tagged built-in", () => {
      const { agentReader, builtInAgents } = createHarness()

      const found = builtInAgents.map((agent) =>
        agentReader.findAgent(agent.code)
      )

      expect(builtInAgents.length).toBeGreaterThan(0)
      expect(found).toEqual(
        builtInAgents.map((agent) => ({ kind: "built-in", ...agent }))
      )
    })

    it("finds a stored agent exactly as stored, tagged custom", () => {
      const { agentReader, saveAgent } = createHarness()
      saveAgent(RESEARCHER)
      saveAgent(ARCHIVIST)

      expect(agentReader.findAgent("researcher")).toEqual({
        kind: "custom",
        ...RESEARCHER
      })
    })

    it("fails when the stored agent is invalid", () => {
      const { agentReader, saveInvalidAgent } = createHarness()
      saveInvalidAgent("damaged")

      expect(() => agentReader.findAgent("damaged")).toThrow(z.ZodError)
    })

    it("fails with `Database is closed` after the owner closes the store", () => {
      const { agentReader, closeStore } = createHarness()
      closeStore()

      expect(() => agentReader.findAgent("researcher")).toThrow(
        "Database is closed"
      )
    })
  })
}

/**
 * Registers the provider-independent {@link AgentEditor} contract cases.
 *
 * @param createHarness - Creates the capabilities over one empty store per
 * case.
 */
export function registerAgentEditorContractSuite(
  createHarness: AgentCapabilitiesHarnessFactory
): void {
  describe("AgentEditor contract", () => {
    it("applies the trimmed change to its agent alone and returns the changed agent", () => {
      const { agentEditor, saveAgent, readStoredAgents } = createHarness()
      saveAgent(RESEARCHER)
      saveAgent(ARCHIVIST)
      const changed = {
        ...RESEARCHER,
        bio: "Cites its sources.",
        updatedAt: expect.any(String)
      }

      expect(
        agentEditor.updateAgent("researcher", { bio: " Cites its sources. " })
      ).toEqual({ status: "updated", agent: changed })

      expect(readStoredAgents()).toEqual([ARCHIVIST, changed])
    })

    it.each(ABSENT_AGENT_CODES)(
      "reports the code %s as missing and changes nothing",
      (code) => {
        const { agentEditor, saveAgent, readStoredAgents } = createHarness()
        saveAgent(RESEARCHER)

        expect(agentEditor.updateAgent(code, { name: "Renamed" })).toEqual({
          status: "missing"
        })

        expect(readStoredAgents()).toEqual([RESEARCHER])
      }
    )

    it("refuses to change a built-in agent and stores nothing", () => {
      const { agentEditor, builtInAgents, readStoredAgents } = createHarness()

      const outcomes = builtInAgents.map((agent) =>
        agentEditor.updateAgent(agent.code, { name: "Renamed" })
      )

      expect(builtInAgents.length).toBeGreaterThan(0)
      expect(outcomes).toEqual(
        builtInAgents.map(() => ({ status: "built-in" }))
      )
      expect(readStoredAgents()).toEqual([])
    })

    it.each([
      ["no field", {}],
      ["only undefined fields", { name: undefined }]
    ])(
      "rejects a change with %s before any storage work",
      (_label, changes) => {
        const harness = createHarness()
        harness.saveAgent(RESEARCHER)
        harness.failAgentWrites(AGENT_WRITE_FAILURE_MESSAGE)

        expect(() =>
          harness.agentEditor.updateAgent("researcher", changes)
        ).toThrow(z.ZodError)

        expect(harness.readStoredAgents()).toEqual([RESEARCHER])
      }
    )

    it("fails and leaves the agent unchanged when the write fails", () => {
      const harness = createHarness()
      harness.saveAgent(RESEARCHER)
      harness.failAgentWrites(AGENT_WRITE_FAILURE_MESSAGE)

      expect(() =>
        harness.agentEditor.updateAgent("researcher", { bio: "Archivist." })
      ).toThrow(AGENT_WRITE_FAILURE_MESSAGE)

      expect(harness.readStoredAgents()).toEqual([RESEARCHER])
    })

    it("fails when the changed agent is invalid", () => {
      const { agentEditor, saveInvalidAgent } = createHarness()
      saveInvalidAgent("damaged")

      expect(() =>
        agentEditor.updateAgent("damaged", { bio: "Archivist." })
      ).toThrow(z.ZodError)
    })

    it("fails with `Database is closed` after the owner closes the store", () => {
      const { agentEditor, closeStore } = createHarness()
      closeStore()

      expect(() =>
        agentEditor.updateAgent("researcher", { bio: "Archivist." })
      ).toThrow("Database is closed")
    })
  })
}

/**
 * Registers the provider-independent {@link AgentDeleter} contract cases.
 *
 * @param createHarness - Creates the capabilities over one empty store per
 * case.
 */
export function registerAgentDeleterContractSuite(
  createHarness: AgentCapabilitiesHarnessFactory
): void {
  describe("AgentDeleter contract", () => {
    it("deletes a stored agent and keeps every other", () => {
      const { agentDeleter, saveAgent, readStoredAgents } = createHarness()
      saveAgent(RESEARCHER)
      saveAgent(ARCHIVIST)

      expect(agentDeleter.deleteAgent("researcher")).toBe("deleted")

      expect(readStoredAgents()).toEqual([ARCHIVIST])
    })

    it("reports a repeated deletion as missing without recreating the agent", () => {
      const { agentDeleter, saveAgent, readStoredAgents } = createHarness()
      saveAgent(RESEARCHER)
      agentDeleter.deleteAgent("researcher")

      expect(agentDeleter.deleteAgent("researcher")).toBe("missing")

      expect(readStoredAgents()).toEqual([])
    })

    it.each(ABSENT_AGENT_CODES)(
      "reports the code %s as missing and deletes nothing",
      (code) => {
        const { agentDeleter, saveAgent, readStoredAgents } = createHarness()
        saveAgent(RESEARCHER)

        expect(agentDeleter.deleteAgent(code)).toBe("missing")

        expect(readStoredAgents()).toEqual([RESEARCHER])
      }
    )

    it("refuses to delete a built-in agent and deletes nothing", () => {
      const harness = createHarness()
      harness.saveAgent(RESEARCHER)

      const outcomes = harness.builtInAgents.map((agent) =>
        harness.agentDeleter.deleteAgent(agent.code)
      )

      expect(harness.builtInAgents.length).toBeGreaterThan(0)
      expect(outcomes).toEqual(harness.builtInAgents.map(() => "built-in"))
      expect(harness.readStoredAgents()).toEqual([RESEARCHER])
    })

    it("fails and keeps the agent when the deletion fails", () => {
      const harness = createHarness()
      harness.saveAgent(RESEARCHER)
      harness.failAgentWrites(AGENT_WRITE_FAILURE_MESSAGE)

      expect(() => harness.agentDeleter.deleteAgent("researcher")).toThrow(
        AGENT_WRITE_FAILURE_MESSAGE
      )

      expect(harness.readStoredAgents()).toEqual([RESEARCHER])
    })

    it("fails with `Database is closed` after the owner closes the store", () => {
      const { agentDeleter, closeStore } = createHarness()
      closeStore()

      expect(() => agentDeleter.deleteAgent("researcher")).toThrow(
        "Database is closed"
      )
    })
  })
}
