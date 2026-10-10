import {
  agentSchema,
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE
} from "@lys/share"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import type Agent from "../../../../src/modules/agent/agent"
import AgentService from "../../../../src/modules/agent/agentService"
import { buildBuiltInAgents } from "../../../../src/modules/agent/builtInAgents"
import type {
  ReplyModel,
  ReplyStreamEvent
} from "../../../../src/modules/agent/replyModel"
import SqliteAgentRecordStore from "../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import { parseAgentListOptions } from "../../../../src/modules/agent/listOptions"
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

/** Summaries every list page carries for {@link BUILT_IN_AGENTS}. */
const BUILT_IN_AGENT_SUMMARIES = [
  { code: "caliginia", name: "Caliginia", bio: "Lys's dark side." },
  { code: "lysiptera", name: "Lysiptera", bio: "Lys's light side." }
]

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
    replyModel
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
    tools: [],
    abortSignal: new AbortController().signal,
    updateAssistantMessageContent: () => true,
    updateAssistantMessageState: () => true,
    sendEvent: vi.fn(),
    sendToolCall: vi.fn(),
    reportReplyCancellation: vi.fn(),
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
 * Creates the agent service over Sqlite records on an in-memory database
 * owned by the current test, for the `AgentCreator` contract suite.
 *
 * @returns The service, a direct read of the stored agent rows, a write
 * failure raised by a temporary trigger on agent inserts, and the database's
 * close.
 */
function createAgentCreatorHarness(): AgentCreatorHarness {
  const { database, recordStore, closeRecords } = openSqliteAgentRecordStore()
  return {
    agentCreator: new AgentService({
      recordStore,
      builtInAgents: BUILT_IN_AGENTS,
      replyModel: createFinishingReplyModel()
    }),
    readStoredAgents: () =>
      z.array(agentSchema).parse(
        database.handleDatabaseReadRequest((statements) =>
          statements
            .getStatement(
              `SELECT code, name, bio, system_prompt AS systemPrompt,
                created_at AS createdAt, updated_at AS updatedAt
              FROM agents ORDER BY code`
            )
            .all()
        )
      ),
    failAgentWrites: (message) => {
      database.handleDatabaseWriteRequest((statements) => {
        statements
          .getStatement(
            `CREATE TEMP TRIGGER fail_agent_writes BEFORE INSERT ON agents
            BEGIN SELECT RAISE(ABORT, '${message.replaceAll("'", "''")}'); END`
          )
          .run()
      })
    },
    closeStore: closeRecords
  }
}

describe("AgentService", () => {
  registerAgentCreatorContractSuite(createAgentCreatorHarness)

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
    it.each(["Not A Slug", "lys", "researcher"])(
      "returns undefined for the code %s, which no agent has",
      (code) => {
        const agents = createAgentService()

        expect(agents.findAgent(code)).toBeUndefined()
      }
    )

    it.each([
      [CALIGINIA_AGENT_CODE, "You are Caliginia."],
      [LYSIPTERA_AGENT_CODE, "You are Lysiptera."]
    ])(
      "finds the built-in agent %s with its shipped prompt and no times",
      (code, systemPrompt) => {
        const found = createAgentService().findAgent(code)

        expect(found).toEqual({
          kind: "built-in",
          ...BUILT_IN_AGENT_SUMMARIES.find((agent) => agent.code === code),
          systemPrompt
        })
        expect(Object.isFrozen(found)).toBe(true)
      }
    )

    it("finds a stored agent as a frozen custom agent", () => {
      const agents = createAgentService()
      const created = agents.createAgent(RESEARCHER_DEFINITION)

      const found = agents.findAgent("researcher")

      expect(found).toEqual({ kind: "custom", ...created })
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

    it.each(["researcher", "lys", "Not A Slug"])(
      "reports the code %s as missing when no agent has it",
      (code) => {
        const agents = createAgentService()

        expect(agents.updateAgent(code, { name: "Renamed" })).toEqual({
          status: "missing"
        })
        expect(agents.findAgent(code)).toBeUndefined()
      }
    )

    it.each([CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE])(
      "refuses to change the built-in agent %s and stores nothing",
      (code) => {
        const agents = createAgentService()
        const shipped = agents.findAgent(code)

        expect(agents.updateAgent(code, { name: "Renamed" })).toEqual({
          status: "built-in"
        })

        expect(agents.findAgent(code)).toEqual(shipped)
        expect(
          agents.listAgents({ cursor: undefined, limit: 30 })
        ).toMatchObject({ agents: [], storedCount: 0 })
      }
    )

    it.each([
      ["no field", {}],
      ["only undefined fields", { name: undefined }]
    ])(
      "rejects a change with %s without touching the agent",
      (_label, changes) => {
        const agents = createAgentService()
        const created = agents.createAgent(RESEARCHER_DEFINITION)
        vi.setSystemTime(new Date(LATER))

        expect(() => agents.updateAgent("researcher", changes)).toThrow(
          z.ZodError
        )

        expect(agents.findAgent("researcher")).toEqual({
          kind: "custom",
          ...created
        })
      }
    )
  })

  describe("listAgents", () => {
    it("pages through agents oldest first and ends with a null cursor", () => {
      const agents = createAgentService()
      agents.createAgent({ ...RESEARCHER_DEFINITION, code: "b" })
      vi.setSystemTime(new Date(LATER))
      agents.createAgent({ ...RESEARCHER_DEFINITION, code: "a" })
      agents.createAgent({ ...RESEARCHER_DEFINITION, code: "c" })

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

    it("carries every built-in agent on every page, Caliginia first and without prompts", () => {
      const agents = createAgentService()
      for (const code of ["a", "b"])
        agents.createAgent({ ...RESEARCHER_DEFINITION, code })

      const first = agents.listAgents({ cursor: undefined, limit: 1 })
      const second = agents.listAgents(
        parseAgentListOptions({ cursor: first.nextCursor ?? "", limit: 1 })
      )

      expect(first.builtInAgents).toEqual(BUILT_IN_AGENT_SUMMARIES)
      expect(second.builtInAgents).toEqual(BUILT_IN_AGENT_SUMMARIES)
    })

    it("lists each agent created in the same millisecond exactly once", () => {
      const agents = createAgentService()
      for (const code of ["c", "a", "b"])
        agents.createAgent({ ...RESEARCHER_DEFINITION, code })

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
      const agents = createAgentService()

      expect(agents.listAgents({ cursor: undefined, limit: 30 })).toEqual({
        builtInAgents: BUILT_IN_AGENT_SUMMARIES,
        agents: [],
        storedCount: 0,
        nextCursor: null
      })
    })
  })

  describe("deleteAgent", () => {
    it("deletes a stored agent once", () => {
      const agents = createAgentService()
      agents.createAgent(RESEARCHER_DEFINITION)

      expect(agents.deleteAgent("researcher")).toBe("deleted")
      expect(agents.findAgent("researcher")).toBeUndefined()
      expect(agents.deleteAgent("researcher")).toBe("missing")
    })

    it.each([CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE])(
      "refuses to delete the built-in agent %s, which still answers chats",
      (code) => {
        const agents = createAgentService()

        expect(agents.deleteAgent(code)).toBe("built-in")

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
