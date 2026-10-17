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
import type Agent from "../../../../src/modules/agent/agent"
import AgentService from "../../../../src/modules/agent/agentService"
import { buildBuiltInAgents } from "../../../../src/modules/agent/builtInAgents"
import type { AgentRecordStore } from "../../../../src/modules/agent/records"
import type {
  ReplyModel,
  ReplyStreamEvent
} from "../../../../src/modules/agent/replyModel"
import SqliteAgentRecordStore from "../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import {
  registerAgentDeleterContractSuite,
  registerAgentEditorContractSuite,
  registerAgentListerContractSuite,
  registerAgentReaderContractSuite,
  type AgentCapabilitiesHarness
} from "../../support/agentCapabilitiesContract"
import { openSqliteAgentRecordStore } from "../../support/agentDatabase"
import {
  registerAgentCreatorContractSuite,
  type AgentCreatorHarness
} from "../../support/agentCreatorContract"
import { openTestDatabase } from "../../support/conversationDatabase"
import { createRoomyReplyContextMeter } from "../../support/replyContextMeterFakes"

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
 * Creates model access whose every reply ends at once.
 *
 * @returns The model, whose stream opener records each call.
 */
function createFinishingReplyModel() {
  return {
    openReplyStream: vi.fn<ReplyModel["openReplyStream"]>(async () =>
      (async function* (): AsyncGenerator<ReplyStreamEvent> {
        yield { type: "finish", finishReason: "stop" }
      })()
    )
  } satisfies ReplyModel
}

/**
 * Creates the agent service over Sqlite records on an in-memory database
 * owned by the current test.
 *
 * @param replyModel - Model access every agent borrows; by default one that
 * ends every reply at once.
 * @returns The ready service.
 */
function createAgentService(
  replyModel: ReplyModel = createFinishingReplyModel()
): AgentService {
  return new AgentService({
    recordStore: new SqliteAgentRecordStore(openTestDatabase()),
    builtInAgents: BUILT_IN_AGENTS,
    replyModel,
    replyContextMeter: createRoomyReplyContextMeter()
  })
}

/**
 * Has an agent answer one turn that says `Hello`, without history or tools.
 *
 * @param agent - Agent that answers.
 * @returns Settlement after the reply is final.
 */
async function createHelloReply(agent: Agent): Promise<void> {
  await agent.createReply({
    history: [],
    userMessageContent: "Hello",
    model: "qwen/qwen3-8b",
    generationOptions: { temperature: 0.4 },
    clientTools: [],
    builtInTools: [],
    abortSignal: new AbortController().signal,
    updateAssistantMessageContent: () => true,
    updateAssistantMessageState: () => true,
    sendEvent: vi.fn(),
    sendClientToolCall: vi.fn(),
    createToolCallGate: vi.fn(),
    reportReplyCancellation: vi.fn(),
    reportReplyRefusal: vi.fn(),
    reportReplyFailure: vi.fn()
  })
}

/**
 * Builds the context a model receives for {@link createHelloReply}.
 *
 * @param systemPrompt - System prompt the answering agent sends first.
 * @returns The expected stream request, matching any other request field.
 */
function buildHelloReplyRequest(systemPrompt: string): unknown {
  return expect.objectContaining({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Hello" }
    ]
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
    builtInAgents: BUILT_IN_AGENTS,
    replyModel: createFinishingReplyModel(),
    replyContextMeter: createRoomyReplyContextMeter()
  })
  return {
    agentCreator: agentService,
    agentLister: agentService,
    agentReader: agentService,
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
        kind: "custom",
        ...expected
      })
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
      "returns the built-in agent %s frozen and without times",
      (code) => {
        const found = createAgentService().findAgent(code)

        expect(found).toMatchObject({ kind: "built-in", code })
        expect(found).not.toHaveProperty("createdAt")
        expect(Object.isFrozen(found)).toBe(true)
      }
    )

    it("returns a stored agent frozen", () => {
      const agents = createAgentService()
      agents.createAgent(RESEARCHER_DEFINITION)

      const found = agents.findAgent("researcher")

      expect(found).toMatchObject({ kind: "custom", code: "researcher" })
      expect(Object.isFrozen(found)).toBe(true)
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
        kind: "custom",
        ...expected
      })
    })
  })

  describe("deleteAgent", () => {
    it.each([CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE])(
      "leaves the built-in agent %s answering chats after refusing to delete it",
      (code) => {
        const agents = createAgentService()

        agents.deleteAgent(code)

        expect(agents.findAgent(code)).toMatchObject({ kind: "built-in" })
        expect(agents.findChatAgent(code)?.code).toBe(code)
      }
    )
  })

  describe("findChatAgent", () => {
    it.each([
      [CALIGINIA_AGENT_CODE, "You are Caliginia."],
      [LYSIPTERA_AGENT_CODE, "You are Lysiptera."]
    ])(
      "finds the built-in agent %s, answering with its shipped prompt",
      async (code, systemPrompt) => {
        const replyModel = createFinishingReplyModel()
        const agent = createAgentService(replyModel).findChatAgent(code)

        if (agent !== undefined) await createHelloReply(agent)

        expect(agent?.code).toBe(code)
        expect(replyModel.openReplyStream).toHaveBeenCalledWith(
          buildHelloReplyRequest(systemPrompt)
        )
      }
    )

    it("finds a stored agent, answering with its stored prompt", async () => {
      const replyModel = createFinishingReplyModel()
      const agents = createAgentService(replyModel)
      agents.createAgent(RESEARCHER_DEFINITION)

      const agent = agents.findChatAgent("researcher")
      if (agent !== undefined) await createHelloReply(agent)

      expect(agent?.code).toBe("researcher")
      expect(replyModel.openReplyStream).toHaveBeenCalledWith(
        buildHelloReplyRequest("You research the web.")
      )
    })

    it("answers with a stored agent's changed prompt once it is looked up again", async () => {
      const replyModel = createFinishingReplyModel()
      const agents = createAgentService(replyModel)
      agents.createAgent(RESEARCHER_DEFINITION)
      agents.updateAgent("researcher", { systemPrompt: "You cite sources." })

      const agent = agents.findChatAgent("researcher")
      if (agent !== undefined) await createHelloReply(agent)

      expect(replyModel.openReplyStream).toHaveBeenCalledWith(
        buildHelloReplyRequest("You cite sources.")
      )
    })

    it.each(["web-researcher", "CALIGINIA", "caliginia-2", "lys", ""])(
      "finds no agent for the code %j",
      (code) => {
        expect(createAgentService().findChatAgent(code)).toBeUndefined()
      }
    )

    it("finds no agent for a deleted agent's code", () => {
      const agents = createAgentService()
      agents.createAgent(RESEARCHER_DEFINITION)
      agents.deleteAgent("researcher")

      expect(agents.findChatAgent("researcher")).toBeUndefined()
    })
  })
})
