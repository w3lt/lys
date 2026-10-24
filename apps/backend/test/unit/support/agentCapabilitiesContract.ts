import type { BuiltInAgentSummary, ListAgentsApiResponse } from "@lys/protocol"
import type { Agent, BuiltInAgent } from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  MAXIMUM_AGENT_SEARCH_MATCHES,
  type AgentDeleter,
  type AgentEditor,
  type AgentLister,
  type AgentReader,
  type AgentSearcher,
  type AgentSearchMatch
} from "../../../src/modules/agent/capabilities"
import { parseAgentListOptions } from "../../../src/modules/agent/listOptions"

/**
 * Agent listing, lookup, search, change, and deletion over one store holding
 * no agent, with the controls a case needs.
 */
export type AgentCapabilitiesHarness = Readonly<{
  /** Agent listing under test. */
  agentLister: AgentLister
  /** Agent lookup under test. */
  agentReader: AgentReader
  /** Agent search under test. */
  agentSearcher: AgentSearcher
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

/** Matches a time in the stored format, such as `2026-01-01T00:00:00.000Z`. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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
 * Builds the search match of one built-in agent.
 *
 * @param agent - Built-in agent as shipped.
 * @returns The match, which is never deleted.
 */
function buildBuiltInAgentMatch(agent: BuiltInAgent): AgentSearchMatch {
  return {
    kind: "built-in",
    code: agent.code,
    name: agent.name,
    bio: agent.bio,
    deletedAt: null
  }
}

/**
 * Reads the first built-in agent the capabilities ship.
 *
 * @param builtInAgents - Built-in agents in the order they are listed.
 * @returns The first one.
 * @throws If no built-in agent ships.
 */
function readFirstBuiltInAgent(
  builtInAgents: readonly BuiltInAgent[]
): BuiltInAgent {
  const [agent] = builtInAgents
  if (agent === undefined)
    throw new Error("Expected at least one built-in agent")
  return agent
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
        builtInAgents.map((agent) => ({
          agent: { kind: "built-in", ...agent },
          deletedAt: null
        }))
      )
    })

    it("finds a stored agent exactly as stored, tagged custom and not deleted", () => {
      const { agentReader, saveAgent } = createHarness()
      saveAgent(RESEARCHER)
      saveAgent(ARCHIVIST)

      expect(agentReader.findAgent("researcher")).toEqual({
        agent: { kind: "custom", ...RESEARCHER },
        deletedAt: null
      })
    })

    it("finds a deleted agent as stored, with the time it was deleted", () => {
      const { agentReader, agentDeleter, saveAgent } = createHarness()
      saveAgent(RESEARCHER)
      agentDeleter.deleteAgent("researcher")

      expect(agentReader.findAgent("researcher")).toEqual({
        agent: { kind: "custom", ...RESEARCHER },
        deletedAt: expect.stringMatching(TIMESTAMP_PATTERN)
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

    it("reports a deleted agent as missing and changes nothing", () => {
      const { agentEditor, agentDeleter, saveAgent, readStoredAgents } =
        createHarness()
      saveAgent(RESEARCHER)
      agentDeleter.deleteAgent("researcher")

      expect(
        agentEditor.updateAgent("researcher", { name: "Renamed" })
      ).toEqual({ status: "missing" })

      expect(readStoredAgents()).toEqual([RESEARCHER])
    })

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
    it("marks a stored agent deleted, keeping it as stored and every other agent", () => {
      const harness = createHarness()
      harness.saveAgent(RESEARCHER)
      harness.saveAgent(ARCHIVIST)

      expect(harness.agentDeleter.deleteAgent("researcher")).toBe("deleted")

      expect(harness.readStoredAgents()).toEqual([ARCHIVIST, RESEARCHER])
      expect(harness.agentReader.findAgent("researcher")?.deletedAt).toEqual(
        expect.stringMatching(TIMESTAMP_PATTERN)
      )
      expect(harness.agentReader.findAgent("archivist")?.deletedAt).toBeNull()
    })

    it("reports a repeated deletion as missing and keeps the first deletion time", () => {
      const { agentDeleter, agentReader, saveAgent } = createHarness()
      saveAgent(RESEARCHER)
      agentDeleter.deleteAgent("researcher")
      const firstDeletedAt = agentReader.findAgent("researcher")?.deletedAt

      expect(agentDeleter.deleteAgent("researcher")).toBe("missing")

      expect(agentReader.findAgent("researcher")?.deletedAt).toBe(
        firstDeletedAt
      )
    })

    it("leaves a deleted agent out of the listing and the stored count", () => {
      const { agentDeleter, agentLister, saveAgent } = createHarness()
      saveAgent(RESEARCHER)
      saveAgent(ARCHIVIST)
      agentDeleter.deleteAgent("researcher")

      const page = agentLister.listAgents(parseAgentListOptions({}))

      expect(page.agents.map((agent) => agent.code)).toEqual(["archivist"])
      expect(page.storedCount).toBe(1)
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
      expect(harness.agentReader.findAgent("researcher")?.deletedAt).toBeNull()
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

/**
 * Registers the provider-independent {@link AgentSearcher} contract cases.
 *
 * @param createHarness - Creates the capabilities over one empty store per
 * case. Every built-in agent it ships names Lys in its bio, and no other
 * built-in agent contains the first one's code or name.
 */
export function registerAgentSearcherContractSuite(
  createHarness: AgentCapabilitiesHarnessFactory
): void {
  describe("AgentSearcher contract", () => {
    it("finds the built-in agents that match, ignoring case, in shipped order", () => {
      const { agentSearcher, builtInAgents } = createHarness()

      expect(agentSearcher.searchAgents("LYS")).toEqual({
        matches: builtInAgents.map(buildBuiltInAgentMatch),
        matchCount: builtInAgents.length
      })
    })

    it("puts a stored agent whose code equals the query before a built-in agent that only contains it", () => {
      const { agentSearcher, builtInAgents, saveAgent } = createHarness()
      const builtInAgent = readFirstBuiltInAgent(builtInAgents)
      const code = builtInAgent.code.slice(0, 4)
      saveAgent(createListedAgent(code, FIRST_CREATED_AT))

      const result = agentSearcher.searchAgents(code.toUpperCase())

      expect(result.matches.map((match) => [match.kind, match.code])).toEqual([
        ["custom", code],
        ["built-in", builtInAgent.code]
      ])
    })

    it("puts a built-in agent whose name equals the query before an equal stored one, and both before the others", () => {
      const { agentSearcher, builtInAgents, saveAgent } = createHarness()
      const builtInAgent = readFirstBuiltInAgent(builtInAgents)
      saveAgent({ ...RESEARCHER, bio: `${builtInAgent.name}'s fan.` })
      saveAgent({
        ...createListedAgent("admirer", SECOND_CREATED_AT),
        name: builtInAgent.name.toLowerCase()
      })

      const result = agentSearcher.searchAgents(builtInAgent.name)

      expect(result.matches.map((match) => [match.kind, match.code])).toEqual([
        ["built-in", builtInAgent.code],
        ["custom", "admirer"],
        ["custom", "researcher"]
      ])
      expect(result.matchCount).toBe(3)
    })

    it("includes a deleted stored agent with the time it was deleted", () => {
      const { agentSearcher, agentDeleter, saveAgent } = createHarness()
      saveAgent(RESEARCHER)
      agentDeleter.deleteAgent("researcher")

      expect(agentSearcher.searchAgents("research")).toEqual({
        matches: [
          {
            kind: "custom",
            code: RESEARCHER.code,
            name: RESEARCHER.name,
            bio: RESEARCHER.bio,
            deletedAt: expect.stringMatching(TIMESTAMP_PATTERN)
          }
        ],
        matchCount: 1
      })
    })

    it("lists the other stored agents by creation time and then code", () => {
      const harness = createHarness()
      saveListedAgents(harness)

      expect(
        harness.agentSearcher
          .searchAgents("agent")
          .matches.map((match) => match.code)
      ).toEqual(["b", "c", "a"])
    })

    it(`keeps the first ${MAXIMUM_AGENT_SEARCH_MATCHES} matches, frozen, and counts every built-in and stored match`, () => {
      const { agentSearcher, builtInAgents, saveAgent } = createHarness()
      const builtInAgent = readFirstBuiltInAgent(builtInAgents)
      const firstCreatedAt = Date.parse(FIRST_CREATED_AT)
      for (let index = 1; index <= MAXIMUM_AGENT_SEARCH_MATCHES; index += 1)
        saveAgent({
          ...createListedAgent(
            `fan-${index}`,
            new Date(firstCreatedAt + index).toISOString()
          ),
          name: `${builtInAgent.name} fan ${index}`
        })

      const result = agentSearcher.searchAgents(builtInAgent.name)

      expect(result.matches).toHaveLength(MAXIMUM_AGENT_SEARCH_MATCHES)
      expect(result.matches[0]).toEqual(buildBuiltInAgentMatch(builtInAgent))
      expect(result.matches.at(-1)?.code).toBe(
        `fan-${MAXIMUM_AGENT_SEARCH_MATCHES - 1}`
      )
      expect(result.matchCount).toBe(MAXIMUM_AGENT_SEARCH_MATCHES + 1)
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.matches)).toBe(true)
      expect(Object.isFrozen(result.matches[0])).toBe(true)
      expect(Object.isFrozen(result.matches.at(-1))).toBe(true)
    })

    it("takes the query literally", () => {
      const { agentSearcher, saveAgent } = createHarness()
      saveAgent(createListedAgent("abc", FIRST_CREATED_AT))

      expect(agentSearcher.searchAgents("a.c")).toEqual({
        matches: [],
        matchCount: 0
      })
    })

    it("fails when a matched stored agent is invalid", () => {
      const { agentSearcher, saveInvalidAgent } = createHarness()
      saveInvalidAgent("damaged")

      expect(() => agentSearcher.searchAgents("damaged")).toThrow(z.ZodError)
    })

    it("fails with `Database is closed` after the owner closes the store", () => {
      const { agentSearcher, closeStore } = createHarness()
      closeStore()

      expect(() => agentSearcher.searchAgents("research")).toThrow(
        "Database is closed"
      )
    })
  })
}
