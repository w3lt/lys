import {
  ARMITAGE_AGENT_CODE,
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE,
  type AgentDefinition,
  type BuiltInAgent
} from "@lys/share"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SqliteAgentRecordStore from "../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import type Agent from "../../../../src/modules/agent/agent"
import type { AgentIdentity } from "../../../../src/modules/agent/agentRoles"
import AgentRuntimeService, {
  buildConversationTitleLookup
} from "../../../../src/modules/agent/agentRuntimeService"
import AgentService from "../../../../src/modules/agent/agentService"
import { buildBuiltInAgents } from "../../../../src/modules/agent/builtInAgents"
import type {
  ReplyModel,
  ReplyStreamEvent,
  ReplyStreamRequest
} from "../../../../src/modules/agent/replyModel"
import { NO_UNOFFERED_TOOLS } from "../../../../src/modules/agent/unofferedTools"
import {
  registerAgentStateReaderContractSuite,
  STATE_READER_ARCHIVIST,
  STATE_READER_DELETED_AT,
  STATE_READER_RESEARCHER,
  type AgentStateReaderHarness
} from "../../support/agentStateReaderContract"
import { openTestDatabase } from "../../support/conversationDatabase"
import {
  createFixtureUuidV7,
  createUserMessage
} from "../../support/conversationFixtures"
import { createRoomyReplyContextMeter } from "../../support/replyContextMeterFakes"
import { LEADER_STATE_TOOL_NAMES } from "../../support/toolFixtures"
import {
  registerToolKeeperContractSuite,
  TOOL_KEEPER_SEARCH_TOOLS,
  type ToolKeeperScript
} from "../../support/toolKeeperContract"

/** Time the clock reads when a case starts. */
const NOW = "2026-10-24T10:00:00.000Z"

/** Built-in agents of every service a case creates. */
const BUILT_IN_AGENTS = buildBuiltInAgents({
  caliginia: "You are Caliginia.",
  lysiptera: "You are Lysiptera.",
  armitage: "You are Armitage."
})

/**
 * Request limits every live agent of a case's runtime gets: two replies at
 * once, one more waiting.
 */
const REQUEST_LIMITS = Object.freeze({ slotCount: 2, waitingLimit: 1 })

/** Caliginia, a built-in agent and so a leader. */
const LEADER: AgentIdentity = Object.freeze({
  code: CALIGINIA_AGENT_CODE,
  role: "leader"
})

/** Model that the runtime under a case borrows, and the case's controls. */
type RuntimeOptions = Readonly<{
  /** Model access every live agent borrows; ends every reply by default. */
  replyModel?: ReplyModel
  /** Agents the backend ships with; {@link BUILT_IN_AGENTS} by default. */
  builtInAgents?: readonly BuiltInAgent[]
  /**
   * Stored conversations by id, each with its title; a conversation it lacks
   * is not stored.
   */
  conversations?: ReadonlyMap<string, Readonly<{ title: string | null }>>
}>

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
 * Creates model access whose replies end only once the case lets them.
 *
 * @returns The model and the release of every reply.
 */
function createWaitingReplyModel() {
  const release = Promise.withResolvers<void>()
  const replyModel: ReplyModel = {
    openReplyStream: async () =>
      (async function* (): AsyncGenerator<ReplyStreamEvent> {
        await release.promise
        yield { type: "finish", finishReason: "stop" }
      })()
  }
  return { replyModel, releaseReplies: () => release.resolve() }
}

/**
 * Creates the stream of one round of a search whose model recommends the
 * first tool of the search, then ends.
 *
 * @param request - The round's request.
 * @returns A stream that finishes when the request's last message is a tool
 * result, and that otherwise calls `recommend_tool` with the first of
 * {@link TOOL_KEEPER_SEARCH_TOOLS}.
 */
async function* createFirstToolRecommendationStream(
  request: ReplyStreamRequest
): AsyncGenerator<ReplyStreamEvent> {
  if (request.messages.at(-1)?.role === "tool") {
    yield { type: "finish", finishReason: "stop" }
    return
  }
  const name = TOOL_KEEPER_SEARCH_TOOLS[0]?.name ?? ""
  const toolCall = {
    toolName: "recommend_tool",
    argumentText: JSON.stringify({ name })
  }
  yield { type: "tool-calls", toolCalls: [toolCall] }
}

/**
 * Creates model access whose every reply follows the script of a search:
 * it recommends the first tool of the search, then ends; it ends at once,
 * recommending nothing; or it fails.
 *
 * @param script - How each search ends.
 * @returns The model, whose stream opener records each call.
 */
function createToolKeeperReplyModel(script: ToolKeeperScript): ReplyModel {
  switch (script) {
    case "finds-first-tool":
      return {
        openReplyStream: vi.fn<ReplyModel["openReplyStream"]>(async (request) =>
          createFirstToolRecommendationStream(request)
        )
      }
    case "finds-nothing":
      return createFinishingReplyModel()
    case "fails":
      return {
        openReplyStream: vi
          .fn<ReplyModel["openReplyStream"]>()
          .mockRejectedValue(new Error("Armitage's model failed"))
      }
  }
}

/**
 * Creates the keeper of one case of the tool keeper contract suite.
 *
 * @param script - How each search ends.
 * @returns A runtime whose Armitage answers on a model that follows the
 * script.
 */
function createScriptedToolKeeper(script: ToolKeeperScript) {
  return createRuntime({ replyModel: createToolKeeperReplyModel(script) })
    .runtime
}

/**
 * Creates the runtime service over an agent service on an in-memory database
 * owned by the current test, every live agent with {@link REQUEST_LIMITS}.
 *
 * @param options - Model access and stored conversations.
 * @returns The runtime, the agent service it reads, and how many agent
 * lookups and searches it made.
 */
function createRuntime(options: RuntimeOptions = {}) {
  const agentService = new AgentService({
    recordStore: SqliteAgentRecordStore.create(openTestDatabase()),
    builtInAgents: options.builtInAgents ?? BUILT_IN_AGENTS
  })
  const agents = {
    findAgent: vi.fn((code: string) => agentService.findAgent(code)),
    listAgentMatches: vi.fn((query: string) =>
      agentService.listAgentMatches(query)
    )
  }
  const conversations = options.conversations ?? new Map()
  const runtime = new AgentRuntimeService({
    agents,
    replyModel: options.replyModel ?? createFinishingReplyModel(),
    replyContextMeter: createRoomyReplyContextMeter(),
    findConversationTitle: (conversationId) =>
      buildConversationTitleLookup(conversations.get(conversationId)),
    requestLimits: REQUEST_LIMITS
  })
  return {
    runtime,
    agentService,
    countAgentReads: () =>
      agents.findAgent.mock.calls.length +
      agents.listAgentMatches.mock.calls.length
  }
}

/**
 * Stores one agent a millisecond after the clock's current time, so each
 * agent stored later is created later.
 *
 * @param agentService - Agents of the runtime under test.
 * @param definition - Valid definition whose code no agent has.
 * @throws If an agent already has the code.
 */
function saveLaterAgent(
  agentService: AgentService,
  definition: AgentDefinition
): void {
  vi.advanceTimersByTime(1)
  if (agentService.createAgent(definition) === undefined)
    throw new Error(`Agent ${definition.code} is already stored`)
}

/** Where a case's turn belongs and what its model is trained for. */
type HelloTurn = Readonly<{
  /** Conversation of the turn; the fixture conversation by default. */
  conversationId?: string
  /** Reply the turn writes; a fixed reply by default. */
  requestId?: string
  /** Whether the model is trained for tool use; false by default. */
  trainedForToolUse?: boolean
}>

/**
 * Has an agent answer one turn that says `Hello`, without history or tools.
 *
 * @param agent - Agent that answers.
 * @param turn - The turn's conversation, reply, and model training.
 * @returns Settlement after the reply is final.
 */
async function createHelloReply(
  agent: Agent,
  turn: HelloTurn = {}
): Promise<void> {
  await agent.createReply({
    conversationId: turn.conversationId ?? createFixtureUuidV7(1),
    requestId: turn.requestId ?? createFixtureUuidV7(2),
    trainedForToolUse: turn.trainedForToolUse ?? false,
    history: [],
    sources: [],
    userMessage: createUserMessage(1, "Hello"),
    canSeeImages: false,
    findAttachmentImage: vi.fn(),
    model: "qwen/qwen3-8b",
    generationOptions: { temperature: 0.4 },
    directTools: [],
    clientTools: [],
    builtInTools: [],
    mcpTools: [],
    unofferedTools: NO_UNOFFERED_TOOLS,
    abortSignal: new AbortController().signal,
    updateAssistantMessageState: () => true,
    findReplyStatus: () => "streaming",
    createReplyPart: vi.fn(),
    updateReplyPartContent: vi.fn(),
    updateReplyToolCall: vi.fn(),
    sendEvent: vi.fn(),
    sendClientToolCall: vi.fn(),
    createToolCallGate: vi.fn(),
    reportReplyCancellation: vi.fn(),
    reportReplyRefusal: vi.fn(),
    reportReplyFailure: vi.fn(),
    reportToolSearchFailure: vi.fn()
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
      { role: "user", content: "Hello", images: [] }
    ]
  })
}

/**
 * Finds the live agent a case needs.
 *
 * @param runtime - The runtime under test.
 * @param code - Code of an agent that is stored and not deleted.
 * @returns The live agent.
 * @throws If the runtime finds none.
 */
function findLiveAgent(runtime: AgentRuntimeService, code: string): Agent {
  const agent = runtime.loadChatAgent(code)
  if (agent === undefined) throw new Error(`No live agent ${code}`)
  return agent
}

describe("buildConversationTitleLookup", () => {
  it.each([
    ["a titled conversation", { title: "Trip to Kyoto" }, "Trip to Kyoto"],
    ["an untitled conversation", { title: null }, null]
  ])("finds the title of %s", (_label, conversation, title) => {
    const lookup = buildConversationTitleLookup(conversation)

    expect(lookup).toEqual({ status: "found", title })
    expect(Object.isFrozen(lookup)).toBe(true)
  })

  it("answers missing when no conversation is stored", () => {
    expect(buildConversationTitleLookup(undefined)).toEqual({
      status: "missing"
    })
  })
})

describe("AgentRuntimeService", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("loadChatAgent", () => {
    it.each([
      [CALIGINIA_AGENT_CODE, "You are Caliginia."],
      [LYSIPTERA_AGENT_CODE, "You are Lysiptera."]
    ])(
      "finds the built-in agent %s, answering with its shipped prompt",
      async (code, systemPrompt) => {
        const replyModel = createFinishingReplyModel()
        const agent = createRuntime({ replyModel }).runtime.loadChatAgent(code)

        if (agent !== undefined) await createHelloReply(agent)

        expect(agent?.code).toBe(code)
        expect(replyModel.openReplyStream).toHaveBeenCalledWith(
          buildHelloReplyRequest(systemPrompt)
        )
      }
    )

    it("finds a stored agent, answering with its stored prompt", async () => {
      const replyModel = createFinishingReplyModel()
      const { runtime, agentService } = createRuntime({ replyModel })
      agentService.createAgent(STATE_READER_RESEARCHER)

      const agent = runtime.loadChatAgent("researcher")
      if (agent !== undefined) await createHelloReply(agent)

      expect(agent?.code).toBe("researcher")
      expect(replyModel.openReplyStream).toHaveBeenCalledWith(
        buildHelloReplyRequest("You research the web.")
      )
    })

    it("gives every load the same live agent, which answers with the agent's prompt as changed since", async () => {
      const replyModel = createFinishingReplyModel()
      const { runtime, agentService } = createRuntime({ replyModel })
      agentService.createAgent(STATE_READER_RESEARCHER)
      const firstLoad = runtime.loadChatAgent("researcher")
      agentService.updateAgent("researcher", {
        systemPrompt: "You cite sources."
      })

      const secondLookup = findLiveAgent(runtime, "researcher")
      await createHelloReply(secondLookup)

      expect(secondLookup).toBe(firstLoad)
      expect(replyModel.openReplyStream).toHaveBeenCalledWith(
        buildHelloReplyRequest("You cite sources.")
      )
    })

    it.each(["web-researcher", "CALIGINIA", "caliginia-2", "lys", ""])(
      "finds no agent for the code %j",
      (code) => {
        expect(createRuntime().runtime.loadChatAgent(code)).toBeUndefined()
      }
    )

    it("finds no chat agent for Armitage, who answers agents, not chats", () => {
      expect(
        createRuntime().runtime.loadChatAgent(ARMITAGE_AGENT_CODE)
      ).toBeUndefined()
    })

    it("finds no agent for a deleted agent's code, even one that was live", () => {
      const { runtime, agentService } = createRuntime()
      agentService.createAgent(STATE_READER_RESEARCHER)
      runtime.loadChatAgent("researcher")
      agentService.deleteAgent("researcher")

      expect(runtime.loadChatAgent("researcher")).toBeUndefined()
    })

    it.each([
      [
        "a built-in agent the leader's",
        CALIGINIA_AGENT_CODE,
        LEADER_STATE_TOOL_NAMES
      ],
      ["a stored agent the member's", "researcher", ["read_my_state"]]
    ])("gives %s state tools", async (_label, code, toolNames) => {
      const replyModel = createFinishingReplyModel()
      const { runtime, agentService } = createRuntime({ replyModel })
      agentService.createAgent(STATE_READER_RESEARCHER)

      await createHelloReply(findLiveAgent(runtime, code), {
        trainedForToolUse: true
      })

      expect(
        replyModel.openReplyStream.mock.calls[0]?.[0].tools.map(
          (tool) => tool.function.name
        )
      ).toEqual(toolNames)
    })
  })

  describe("state reads", () => {
    registerAgentStateReaderContractSuite((): AgentStateReaderHarness => {
      const { runtime, agentService, countAgentReads } = createRuntime()
      vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"))
      agentService.createAgent(STATE_READER_RESEARCHER)
      vi.setSystemTime(new Date("2026-10-19T00:00:00.000Z"))
      agentService.createAgent(STATE_READER_ARCHIVIST)
      vi.setSystemTime(new Date(STATE_READER_DELETED_AT))
      agentService.deleteAgent(STATE_READER_ARCHIVIST.code)
      vi.setSystemTime(new Date(NOW))
      return {
        reader: runtime,
        requestSlotCount: REQUEST_LIMITS.slotCount,
        countAgentReads,
        saveAgent: (definition) => {
          saveLaterAgent(agentService, definition)
        }
      }
    })

    it("lists a live agent's requests in start order, the one waiting for a request slot last, each with its conversation's title as it is now", async () => {
      const titled = createFixtureUuidV7(11)
      const untitled = createFixtureUuidV7(12)
      const deleted = createFixtureUuidV7(13)
      const { replyModel, releaseReplies } = createWaitingReplyModel()
      const { runtime } = createRuntime({
        replyModel,
        conversations: new Map([
          [titled, { title: "Trip to Kyoto" }],
          [untitled, { title: null }]
        ])
      })
      const caliginia = findLiveAgent(runtime, CALIGINIA_AGENT_CODE)
      const replies = [titled, untitled, deleted].map((conversationId, index) =>
        createHelloReply(caliginia, {
          conversationId,
          requestId: createFixtureUuidV7(21 + index)
        })
      )

      const outcome = runtime.findAgentState(LEADER, CALIGINIA_AGENT_CODE)
      releaseReplies()
      await Promise.all(replies)

      expect(outcome).toMatchObject({
        status: "found",
        state: {
          requestSlotCount: REQUEST_LIMITS.slotCount,
          requests: [
            {
              requestId: createFixtureUuidV7(21),
              conversationId: titled,
              conversationTitle: { status: "found", title: "Trip to Kyoto" },
              model: "qwen/qwen3-8b",
              startedAt: NOW,
              step: { kind: "preparing", round: 0 }
            },
            {
              requestId: createFixtureUuidV7(22),
              conversationTitle: { status: "found", title: null },
              step: { kind: "preparing", round: 0 }
            },
            {
              requestId: createFixtureUuidV7(23),
              conversationTitle: { status: "missing" },
              step: { kind: "waiting" }
            }
          ]
        }
      })
      expect(
        outcome.status === "found" && Object.isFrozen(outcome.state.requests[0])
      ).toBe(true)
      expect(
        runtime.findAgentState(LEADER, CALIGINIA_AGENT_CODE)
      ).toMatchObject({ state: { requests: [] } })
    })

    it("gives each live agent its own request slots, so one agent's held slots never hold back another's reply", async () => {
      const { replyModel, releaseReplies } = createWaitingReplyModel()
      const { runtime } = createRuntime({ replyModel })
      const caliginia = findLiveAgent(runtime, CALIGINIA_AGENT_CODE)
      const lysiptera = findLiveAgent(runtime, LYSIPTERA_AGENT_CODE)
      const replies = [21, 22].map((sequence) =>
        createHelloReply(caliginia, {
          conversationId: createFixtureUuidV7(sequence + 10),
          requestId: createFixtureUuidV7(sequence)
        })
      )

      replies.push(
        createHelloReply(lysiptera, { requestId: createFixtureUuidV7(23) })
      )
      const outcome = runtime.findAgentState(LEADER, LYSIPTERA_AGENT_CODE)
      releaseReplies()
      await Promise.all(replies)

      expect(outcome).toMatchObject({
        status: "found",
        state: {
          requestSlotCount: REQUEST_LIMITS.slotCount,
          requests: [
            {
              requestId: createFixtureUuidV7(23),
              step: { kind: "preparing", round: 0 }
            }
          ]
        }
      })
    })

    it("keeps listing the reply of an agent deleted while it writes, showing the deletion", async () => {
      const { replyModel, releaseReplies } = createWaitingReplyModel()
      const { runtime, agentService } = createRuntime({ replyModel })
      agentService.createAgent(STATE_READER_RESEARCHER)
      const reply = createHelloReply(findLiveAgent(runtime, "researcher"))

      agentService.deleteAgent("researcher")
      const outcome = runtime.findAgentState(LEADER, "researcher")
      releaseReplies()
      await reply

      expect(outcome).toMatchObject({
        status: "found",
        state: {
          deletedAt: NOW,
          requests: [{ requestId: createFixtureUuidV7(2) }]
        }
      })
      expect(runtime.loadChatAgent("researcher")).toBeUndefined()
    })

    it("reads an agent no turn has loaded as working on nothing, and its first load answers with its prompt as changed since", async () => {
      const replyModel = createFinishingReplyModel()
      const { runtime, agentService } = createRuntime({ replyModel })
      agentService.createAgent(STATE_READER_RESEARCHER)

      const outcome = runtime.findAgentState(LEADER, "researcher")
      agentService.updateAgent("researcher", {
        systemPrompt: "You cite sources."
      })
      await createHelloReply(findLiveAgent(runtime, "researcher"))

      expect(outcome).toMatchObject({ state: { requests: [] } })
      expect(replyModel.openReplyStream).toHaveBeenCalledWith(
        buildHelloReplyRequest("You cite sources.")
      )
    })
  })
  describe("tool searches", () => {
    registerToolKeeperContractSuite(createScriptedToolKeeper)

    it("runs each search on Armitage's live agent, with Armitage's prompt, as one of its requests on the asking conversation", async () => {
      const conversationId = createFixtureUuidV7(31)
      const { replyModel, releaseReplies } = createWaitingReplyModel()
      const openReplyStream = vi.spyOn(replyModel, "openReplyStream")
      const { runtime } = createRuntime({
        replyModel,
        conversations: new Map([[conversationId, { title: "Reading list" }]])
      })

      const search = runtime.findTools({
        task: "read a web page",
        tools: TOOL_KEEPER_SEARCH_TOOLS,
        conversationId,
        model: "qwen/qwen3-8b",
        generationOptions: { temperature: 0.2 },
        abortSignal: new AbortController().signal,
        reportFailure: vi.fn()
      })
      await vi.waitFor(() => {
        expect(openReplyStream).toHaveBeenCalledOnce()
      })
      const state = runtime.findAgentState(LEADER, ARMITAGE_AGENT_CODE)
      releaseReplies()

      await expect(search).resolves.toEqual({ status: "found", toolNames: [] })
      expect(openReplyStream.mock.calls[0]?.[0].messages[0]).toEqual({
        role: "system",
        content: "You are Armitage."
      })
      expect(state).toMatchObject({
        status: "found",
        state: {
          role: "tool-keeper",
          requests: [
            {
              conversationId,
              conversationTitle: { status: "found", title: "Reading list" }
            }
          ]
        }
      })
      expect(runtime.loadChatAgent(ARMITAGE_AGENT_CODE)).toBeUndefined()
    })

    describe("without Armitage among the built-in agents", () => {
      /**
       * Starts a search on a runtime whose built-in agents lack Armitage.
       *
       * @param abortSignal - Cancellation of the asking reply.
       * @returns The search's promise, the spy that receives its failures,
       * and the runtime's model.
       */
      function findToolsWithoutArmitage(abortSignal: AbortSignal) {
        const replyModel = createFinishingReplyModel()
        const { runtime } = createRuntime({
          replyModel,
          builtInAgents: BUILT_IN_AGENTS.filter(
            (agent) => agent.code !== ARMITAGE_AGENT_CODE
          )
        })
        const reportFailure = vi.fn()
        const search = runtime.findTools({
          task: "read a web page",
          tools: TOOL_KEEPER_SEARCH_TOOLS,
          conversationId: createFixtureUuidV7(31),
          model: "qwen/qwen3-8b",
          generationOptions: { temperature: 0.2 },
          abortSignal,
          reportFailure
        })
        return { search, reportFailure, replyModel }
      }

      it("fails a search, after reporting why once, without reaching the model", async () => {
        const { search, reportFailure, replyModel } = findToolsWithoutArmitage(
          new AbortController().signal
        )

        await expect(search).resolves.toEqual({ status: "failed" })
        expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
          new Error("Armitage, the built-in tool keeper, is not defined")
        )
        expect(replyModel.openReplyStream).not.toHaveBeenCalled()
      })

      it("rejects with the abort reason of a search stopped before it starts, reporting nothing", async () => {
        const stopReason = new Error("stopped")

        const { search, reportFailure } = findToolsWithoutArmitage(
          AbortSignal.abort(stopReason)
        )

        await expect(search).rejects.toBe(stopReason)
        expect(reportFailure).not.toHaveBeenCalled()
      })
    })
  })
})
