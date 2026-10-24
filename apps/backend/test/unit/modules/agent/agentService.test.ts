import {
  agentSchema,
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE,
  type Agent as StoredAgent
} from "@lys/share"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import type {
  DatabaseReader,
  DatabaseWriter
} from "../../../../src/infrastructure/database/databaseTransactions"
import AgentService from "../../../../src/modules/agent/agentService"
import { buildBuiltInAgents } from "../../../../src/modules/agent/builtInAgents"
import type { AgentRecordStore } from "../../../../src/modules/agent/records"
import SqliteAgentRecordStore from "../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import {
  registerAgentDeleterContractSuite,
  registerAgentEditorContractSuite,
  registerAgentListerContractSuite,
  registerAgentReaderContractSuite,
  registerAgentSearcherContractSuite,
  type AgentCapabilitiesHarness
} from "../../support/agentCapabilitiesContract"
import { openSqliteAgentRecordStore } from "../../support/agentDatabase"
import {
  registerAgentCreatorContractSuite,
  type AgentCreatorHarness
} from "../../support/agentCreatorContract"
import { openTestDatabase } from "../../support/conversationDatabase"

/** Time the clock reads when a case starts. */
const NOW = "2026-05-06T07:08:09.123Z"

/** Time a case moves the clock to before a later change. */
const LATER = "2026-05-07T00:00:00.000Z"

/** Built-in agents of every service a case creates. */
const BUILT_IN_AGENTS = buildBuiltInAgents({
  caliginia: "You are Caliginia.",
  lysiptera: "You are Lysiptera."
})

/** Definition of the agent most cases store. */
const RESEARCHER_DEFINITION = {
  code: "researcher",
  name: "Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web."
}

/**
 * Creates the agent service over Sqlite records on an in-memory database
 * owned by the current test.
 *
 * @returns The ready service.
 */
function createAgentService(): AgentService {
  return new AgentService({
    recordStore: SqliteAgentRecordStore.create(openTestDatabase()),
    builtInAgents: BUILT_IN_AGENTS
  })
}

/**
 * Agent service over its own database, with the controls of every agent
 * contract suite.
 */
type AgentServiceHarness = AgentCreatorHarness & AgentCapabilitiesHarness

/** Statements whose failure a case induces on the agents table. */
const AGENT_WRITE_OPERATIONS: readonly string[] = Object.freeze([
  "INSERT",
  "UPDATE",
  "DELETE"
])

/**
 * Stores one agent through the records, bypassing the agent service.
 *
 * @param recordStore - Records over a migrated test database.
 * @param agent - Valid agent to store exactly as given.
 * @throws If an agent with the same code is already stored.
 */
function saveStoredAgent(
  recordStore: AgentRecordStore,
  agent: StoredAgent
): void {
  if (!recordStore.createAgent(agent))
    throw new Error(`Agent ${agent.code} is already stored`)
}

/**
 * Inserts one agent row whose creation time is not an agent timestamp,
 * bypassing the agent schemas.
 *
 * @param database - Write access to a migrated test database.
 * @param code - Code of the row.
 */
function saveInvalidAgentRow(database: DatabaseWriter, code: string): void {
  database.handleDatabaseWriteRequest((statements) => {
    statements
      .getStatement(
        `INSERT INTO agents (code, name, bio, system_prompt, created_at, updated_at)
        VALUES (?, 'Damaged', 'Has no valid time.', 'You are damaged.', 'never', 'never')`
      )
      .run(code)
  })
}

/**
 * Reads every stored agent row in code order, bypassing the agent service.
 *
 * @param database - Read access to a migrated test database.
 * @returns The stored agents.
 * @throws If a row violates the agent schema.
 */
function readStoredAgents(database: DatabaseReader): readonly StoredAgent[] {
  return z.array(agentSchema).parse(
    database.handleDatabaseReadRequest((statements) =>
      statements
        .getStatement(
          `SELECT code, name, bio, system_prompt AS systemPrompt,
            created_at AS createdAt, updated_at AS updatedAt
          FROM agents ORDER BY code`
        )
        .all()
    )
  )
}

/**
 * Makes every later insert, update, and delete of an agent row fail, through
 * temporary triggers that last until the database closes.
 *
 * @param database - Write access to a migrated test database.
 * @param message - Message of the failure each write raises.
 */
function startAgentWriteFailures(
  database: DatabaseWriter,
  message: string
): void {
  const quotedMessage = message.replaceAll("'", "''")
  database.handleDatabaseWriteRequest((statements) => {
    for (const operation of AGENT_WRITE_OPERATIONS)
      statements
        .getStatement(
          `CREATE TEMP TRIGGER fail_agent_${operation} BEFORE ${operation} ON agents
          BEGIN SELECT RAISE(ABORT, '${quotedMessage}'); END`
        )
        .run()
  })
}

/**
 * Creates the agent service over Sqlite records on an in-memory database
 * owned by the current test, for the agent contract suites.
 *
 * @returns The service as each capability under test, its built-in agents,
 * direct writes and reads of the stored agent rows, a write failure raised by
 * temporary triggers on the agents table, and the database's close.
 */
function createAgentServiceHarness(): AgentServiceHarness {
  const { database, recordStore, closeRecords } = openSqliteAgentRecordStore()
  const agentService = new AgentService({
    recordStore,
    builtInAgents: BUILT_IN_AGENTS
  })
  return {
    agentCreator: agentService,
    agentLister: agentService,
    agentReader: agentService,
    agentSearcher: agentService,
    agentEditor: agentService,
    agentDeleter: agentService,
    builtInAgents: BUILT_IN_AGENTS,
    saveAgent: (agent) => saveStoredAgent(recordStore, agent),
    saveInvalidAgent: (code) => saveInvalidAgentRow(database, code),
    readStoredAgents: () => readStoredAgents(database),
    failAgentWrites: (message) => startAgentWriteFailures(database, message),
    closeStore: closeRecords
  }
}

describe("AgentService", () => {
  registerAgentCreatorContractSuite(createAgentServiceHarness)
  registerAgentListerContractSuite(createAgentServiceHarness)
  registerAgentReaderContractSuite(createAgentServiceHarness)
  registerAgentSearcherContractSuite(createAgentServiceHarness)
  registerAgentEditorContractSuite(createAgentServiceHarness)
  registerAgentDeleterContractSuite(createAgentServiceHarness)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("createAgent", () => {
    it("stores the trimmed definition stamped with the current time", () => {
      const agents = createAgentService()
      const expected = {
        ...RESEARCHER_DEFINITION,
        createdAt: NOW,
        updatedAt: NOW
      }

      const created = agents.createAgent({
        ...RESEARCHER_DEFINITION,
        name: "  Researcher  ",
        systemPrompt: "\nYou research the web.\n"
      })

      expect(created).toEqual(expected)
      expect(Object.isFrozen(created)).toBe(true)
      expect(agents.findAgent("researcher")).toEqual({
        agent: { kind: "custom", ...expected },
        deletedAt: null
      })
    })

    it("refuses a deleted agent's code and keeps the deleted agent", () => {
      const agents = createAgentService()
      agents.createAgent(RESEARCHER_DEFINITION)
      agents.deleteAgent("researcher")
      vi.setSystemTime(new Date(LATER))

      expect(
        agents.createAgent({ ...RESEARCHER_DEFINITION, name: "Successor" })
      ).toBeUndefined()

      expect(agents.findAgent("researcher")).toEqual({
        agent: {
          kind: "custom",
          ...RESEARCHER_DEFINITION,
          createdAt: NOW,
          updatedAt: NOW
        },
        deletedAt: NOW
      })
    })

    it("skips a deleted agent's code when the name gives it", () => {
      const agents = createAgentService()
      agents.createAgent(RESEARCHER_DEFINITION)
      agents.deleteAgent("researcher")

      expect(
        agents.createAgent({ ...RESEARCHER_DEFINITION, code: undefined })
      ).toMatchObject({ code: "researcher-2" })
    })

    it("finds a free code when the first try equals the second", () => {
      const agents = createAgentService()
      agents.createAgent({
        ...RESEARCHER_DEFINITION,
        code: `${"a".repeat(62)}-2`
      })

      expect(
        agents.createAgent({
          ...RESEARCHER_DEFINITION,
          code: undefined,
          name: `${"a".repeat(62)} 2`
        })
      ).toMatchObject({ code: `${"a".repeat(62)}-3` })
    })

    it("derives `agent` from a name without an ASCII letter or digit", () => {
      const agents = createAgentService()

      expect(
        agents.createAgent({
          ...RESEARCHER_DEFINITION,
          code: undefined,
          name: "日本語"
        })
      ).toMatchObject({ code: "agent", name: "日本語" })
    })

    it("rejects a creation time outside the stored format without storing anything", () => {
      const agents = createAgentService()
      vi.setSystemTime(new Date("+010000-01-01T00:00:00.000Z"))

      expect(() => agents.createAgent(RESEARCHER_DEFINITION)).toThrow(
        z.ZodError
      )

      expect(agents.findAgent("researcher")).toBeUndefined()
    })
  })

  describe("findAgent", () => {
    it.each([CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE])(
      "returns the built-in agent %s frozen, not deleted, and without times",
      (code) => {
        const found = createAgentService().findAgent(code)

        expect(found).toMatchObject({
          agent: { kind: "built-in", code },
          deletedAt: null
        })
        expect(found?.agent).not.toHaveProperty("createdAt")
        expect(Object.isFrozen(found)).toBe(true)
        expect(Object.isFrozen(found?.agent)).toBe(true)
      }
    )

    it("returns a stored agent frozen", () => {
      const agents = createAgentService()
      agents.createAgent(RESEARCHER_DEFINITION)

      const found = agents.findAgent("researcher")

      expect(found).toMatchObject({
        agent: { kind: "custom", code: "researcher" },
        deletedAt: null
      })
      expect(Object.isFrozen(found)).toBe(true)
      expect(Object.isFrozen(found?.agent)).toBe(true)
    })
  })

  describe("updateAgent", () => {
    it("stores the trimmed change at the current time and keeps the creation time", () => {
      const agents = createAgentService()
      agents.createAgent(RESEARCHER_DEFINITION)
      vi.setSystemTime(new Date(LATER))
      const expected = {
        ...RESEARCHER_DEFINITION,
        bio: "Archivist.",
        createdAt: NOW,
        updatedAt: LATER
      }

      expect(agents.updateAgent("researcher", { bio: " Archivist. " })).toEqual(
        { status: "updated", agent: expected }
      )

      expect(agents.findAgent("researcher")).toEqual({
        agent: { kind: "custom", ...expected },
        deletedAt: null
      })
    })
  })

  describe("deleteAgent", () => {
    it("marks the agent deleted at the current time and keeps its last change time", () => {
      const agents = createAgentService()
      agents.createAgent(RESEARCHER_DEFINITION)
      vi.setSystemTime(new Date(LATER))

      expect(agents.deleteAgent("researcher")).toBe("deleted")

      expect(agents.findAgent("researcher")).toEqual({
        agent: {
          kind: "custom",
          ...RESEARCHER_DEFINITION,
          createdAt: NOW,
          updatedAt: NOW
        },
        deletedAt: LATER
      })
    })

    it.each([CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE])(
      "leaves the built-in agent %s as it was after refusing to delete it",
      (code) => {
        const agents = createAgentService()

        agents.deleteAgent(code)

        expect(agents.findAgent(code)).toMatchObject({
          agent: { kind: "built-in" },
          deletedAt: null
        })
      }
    )
  })
})
