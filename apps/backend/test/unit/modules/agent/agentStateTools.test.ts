import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AgentRequestStep,
  AgentToolCallState,
  AgentToolCallStatus
} from "../../../../src/modules/agent/agentActivity"
import type { AgentIdentity } from "../../../../src/modules/agent/agentRoles"
import {
  buildAgentStateDefinitions,
  buildAgentStateTools,
  type AgentRequestView,
  type AgentSearchOutcome,
  type AgentStateOutcome,
  type AgentStateReader,
  type ConversationTitleLookup
} from "../../../../src/modules/agent/agentStateTools"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  TurnBuiltInTool
} from "../../../../src/modules/tool/builtIn/builtInTool"
import {
  registerArgumentFreeBuiltInToolContractSuite,
  registerBuiltInToolContractSuite,
  type BuiltInToolHarness,
  type RunnableBuiltInToolHarness
} from "../../support/builtInToolContract"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Time the clock reads during every run. */
const NOW = "2026-10-24T10:05:30.000Z"

/** Reply of the turn whose model calls the tools. */
const OWN_REQUEST_ID = createFixtureUuidV7(101)

/** The leader that calls the tools in most cases. */
const LEADER: AgentIdentity = Object.freeze({
  code: "caliginia",
  role: "leader"
})

/** A member that calls the tools in some cases. */
const MEMBER: AgentIdentity = Object.freeze({
  code: "researcher",
  role: "member"
})

/** The calling turn's own request, at its first round. */
const OWN_REQUEST: AgentRequestView = Object.freeze({
  requestId: OWN_REQUEST_ID,
  conversationId: createFixtureUuidV7(1),
  model: "qwen/qwen3-8b",
  startedAt: "2026-10-24T10:05:00.000Z",
  step: Object.freeze({ kind: "preparing", round: 0 }),
  conversationTitle: Object.freeze({ status: "found", title: "Trip to Kyoto" })
})

/** What another request of the agent may change from the own request. */
type RequestVariation = Readonly<{
  /** Start time; the own request's by default. */
  startedAt?: string
  /** Model; the own request's by default. */
  model?: string
  /** Step; the own request's by default. */
  step?: AgentRequestStep
  /** Title of its conversation; the own request's by default. */
  conversationTitle?: ConversationTitleLookup
}>

/**
 * Builds another request of the agent, in the own request's conversation.
 *
 * @param sequence - Identity sequence of its reply.
 * @param variation - Fields that differ from the own request.
 * @returns The request as the reader shows it.
 */
function buildRequest(
  sequence: number,
  variation: RequestVariation
): AgentRequestView {
  return {
    requestId: createFixtureUuidV7(sequence),
    conversationId: OWN_REQUEST.conversationId,
    model: variation.model ?? OWN_REQUEST.model,
    startedAt: variation.startedAt ?? OWN_REQUEST.startedAt,
    step: variation.step ?? OWN_REQUEST.step,
    conversationTitle:
      variation.conversationTitle ?? OWN_REQUEST.conversationTitle
  }
}

/**
 * Builds one tool call of a request's round.
 *
 * @param sequence - Identity sequence of the call.
 * @param toolName - Name of the called tool.
 * @param status - Status of the call.
 * @returns The call's state.
 */
function buildToolCall(
  sequence: number,
  toolName: string,
  status: AgentToolCallStatus
): AgentToolCallState {
  return { toolCallId: createFixtureUuidV7(sequence), toolName, status }
}

/**
 * Creates a reader whose answers a case sets.
 *
 * @param answers - Outcomes of each read; a read the case did not arrange
 * throws.
 * @returns The reader, its calls recorded.
 */
function createReader(
  answers: Readonly<{
    state?: AgentStateOutcome
    search?: AgentSearchOutcome
  }>
) {
  return {
    listAgentMatches: vi.fn<AgentStateReader["listAgentMatches"]>(() => {
      if (answers.search === undefined) throw new Error("Unexpected search")
      return answers.search
    }),
    findAgentState: vi.fn<AgentStateReader["findAgentState"]>(() => {
      if (answers.state === undefined) throw new Error("Unexpected read")
      return answers.state
    })
  } satisfies AgentStateReader
}

/**
 * Finds one state tool of a turn.
 *
 * @param tools - The turn's state tools.
 * @param name - Name of the tool.
 * @returns The tool.
 * @throws If the turn has no tool of that name.
 */
function findStateTool(
  tools: readonly TurnBuiltInTool[],
  name: string
): BuiltInTool {
  const entry = tools.find((tool) => tool.definition.name === name)
  if (entry === undefined) throw new Error(`No tool named ${name}`)
  return entry.tool
}

/**
 * Parses and runs one call of a state tool.
 *
 * @param tools - The turn's state tools.
 * @param name - Name of the called tool.
 * @param callArguments - Argument values of the call.
 * @returns The run's result, or the parse outcome when it is invalid.
 */
async function runStateTool(
  tools: readonly TurnBuiltInTool[],
  name: string,
  callArguments: BuiltInToolCallArguments = {}
): Promise<
  BuiltInToolResult | Readonly<{ status: "invalid"; message: string }>
> {
  const parsed = findStateTool(tools, name).parseToolCall(callArguments)
  if (parsed.status === "invalid") return parsed
  return await parsed.runToolCall({
    abortSignal: new AbortController().signal,
    addWebSources: () => []
  })
}

describe("buildAgentStateDefinitions", () => {
  it("gives a leader read_my_state, find_agents, and read_agent_state, in that order", () => {
    const definitions = buildAgentStateDefinitions("leader")

    expect(definitions.map((definition) => definition.name)).toEqual([
      "read_my_state",
      "find_agents",
      "read_agent_state"
    ])
    expect(definitions).toEqual([
      expect.objectContaining({ arguments: [] }),
      expect.objectContaining({
        arguments: [expect.objectContaining({ type: "string", name: "query" })]
      }),
      expect.objectContaining({
        arguments: [expect.objectContaining({ type: "string", name: "code" })]
      })
    ])
  })

  it("gives a member read_my_state only, saying it sees only its own state", () => {
    const definitions = buildAgentStateDefinitions("member")

    expect(definitions.map((definition) => definition.name)).toEqual([
      "read_my_state"
    ])
    expect(definitions[0]?.description).toContain(
      "You can see only your own state."
    )
  })

  it.each(["leader", "member"] as const)(
    "lists every %s tool in the agents group, reading this machine, run by the backend",
    (role) => {
      for (const definition of buildAgentStateDefinitions(role))
        expect(definition).toMatchObject({
          group: "agents",
          access: "reads",
          runner: "backend"
        })
    }
  )
})

describe("buildAgentStateTools", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("builds a tool for each of the role's definitions, each running without approval", () => {
    const reader = createReader({})

    const leaderTools = buildAgentStateTools({
      self: LEADER,
      requestId: OWN_REQUEST_ID,
      reader
    })
    const memberTools = buildAgentStateTools({
      self: MEMBER,
      requestId: OWN_REQUEST_ID,
      reader
    })

    expect(leaderTools.map((tool) => tool.definition)).toEqual(
      buildAgentStateDefinitions("leader")
    )
    expect(memberTools.map((tool) => tool.definition)).toEqual(
      buildAgentStateDefinitions("member")
    )
    for (const tool of [...leaderTools, ...memberTools])
      expect(tool.runsWithoutApproval).toBe(true)
  })

  describe("read_my_state", () => {
    registerArgumentFreeBuiltInToolContractSuite(
      async (): Promise<RunnableBuiltInToolHarness> => {
        const reader = createReader({
          state: {
            status: "found",
            state: {
              code: MEMBER.code,
              name: "Researcher",
              role: "member",
              deletedAt: null,
              requests: [OWN_REQUEST]
            }
          }
        })
        return {
          tool: findStateTool(
            buildAgentStateTools({
              self: MEMBER,
              requestId: OWN_REQUEST_ID,
              reader
            }),
            "read_my_state"
          ),
          runnableArguments: {},
          countStartedWork: () => reader.findAgentState.mock.calls.length
        }
      }
    )

    it("tells a leader who it is and each request it works on, marking the calling one", async () => {
      const reader = createReader({
        state: {
          status: "found",
          state: {
            code: "caliginia",
            name: "Caliginia",
            role: "leader",
            deletedAt: null,
            requests: [
              buildRequest(102, {
                startedAt: "2026-10-24T09:58:10.000Z",
                model: "qwen/qwen3-14b",
                step: {
                  kind: "using-tools",
                  round: 1,
                  toolCalls: [
                    buildToolCall(201, "web_search", "succeeded"),
                    buildToolCall(202, "read_page", "awaiting-approval")
                  ]
                },
                conversationTitle: { status: "found", title: "Weekly plan" }
              }),
              OWN_REQUEST
            ]
          }
        }
      })
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      const result = await runStateTool(tools, "read_my_state")

      expect(result).toEqual({
        status: "succeeded",
        content: [
          "You are Caliginia (code caliginia), a leader. As a leader you can find other agents with find_agents and read their state with read_agent_state.",
          "Now: 2026-10-24T10:05:30.000Z.",
          "Working on 2 requests:",
          `1. In "Weekly plan": started 2026-10-24T09:58:10.000Z (7 minutes ago) with qwen/qwen3-14b; using tools: web_search done, read_page waiting for the person's approval.`,
          "2. This reply, in this conversation: started 2026-10-24T10:05:00.000Z (less than a minute ago) with qwen/qwen3-8b; getting ready to answer."
        ].join("\n"),
        sources: []
      })
      expect(reader.findAgentState).toHaveBeenCalledExactlyOnceWith(
        LEADER,
        "caliginia"
      )
    })

    it("tells a member that it sees only its own state, and that nothing else is in progress when the calling reply is its only request", async () => {
      const reader = createReader({
        state: {
          status: "found",
          state: {
            code: "researcher",
            name: "Researcher",
            role: "member",
            deletedAt: null,
            requests: [OWN_REQUEST]
          }
        }
      })
      const tools = buildAgentStateTools({
        self: MEMBER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      const result = await runStateTool(tools, "read_my_state")

      expect(result).toMatchObject({
        status: "succeeded",
        content: [
          "You are Researcher (code researcher), a member. As a member you can see only your own state.",
          "Now: 2026-10-24T10:05:30.000Z.",
          "Working on 1 request:",
          "1. This reply, in this conversation: started 2026-10-24T10:05:00.000Z (less than a minute ago) with qwen/qwen3-8b; getting ready to answer.",
          "Nothing else is in progress."
        ].join("\n")
      })
    })

    it("tells a deleted agent when it was deleted", async () => {
      const reader = createReader({
        state: {
          status: "found",
          state: {
            code: "researcher",
            name: "Researcher",
            role: "member",
            deletedAt: "2026-10-24T10:04:00.000Z",
            requests: [OWN_REQUEST]
          }
        }
      })
      const tools = buildAgentStateTools({
        self: MEMBER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      const result = await runStateTool(tools, "read_my_state")

      expect(result).toMatchObject({
        content: expect.stringMatching(
          /^You are Researcher \(code researcher\), a member\. You were deleted on 2026-10-24T10:04:00\.000Z\. As a member/
        )
      })
    })

    it("reads the state when it runs, not when it is parsed", async () => {
      const reader = createReader({
        state: {
          status: "found",
          state: {
            code: "caliginia",
            name: "Caliginia",
            role: "leader",
            deletedAt: null,
            requests: [OWN_REQUEST]
          }
        }
      })
      const [readMyState] = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader
      })
      const parsed = readMyState?.tool.parseToolCall({})

      expect(reader.findAgentState).not.toHaveBeenCalled()
      if (parsed?.status !== "parsed") throw new Error("Not parsed")
      vi.setSystemTime(new Date("2026-10-24T10:07:00.000Z"))
      const result = await parsed.runToolCall({
        abortSignal: new AbortController().signal,
        addWebSources: () => []
      })

      expect(result).toMatchObject({
        content: expect.stringContaining(
          "Now: 2026-10-24T10:07:00.000Z.\nWorking on 1 request:\n1. This reply, in this conversation: started 2026-10-24T10:05:00.000Z (2 minutes ago)"
        )
      })
    })
  })

  describe("read_agent_state", () => {
    registerBuiltInToolContractSuite(async (): Promise<BuiltInToolHarness> => {
      const reader = createReader({
        state: {
          status: "found",
          state: {
            code: "lysiptera",
            name: "Lysiptera",
            role: "leader",
            deletedAt: null,
            requests: []
          }
        }
      })
      return {
        tool: findStateTool(
          buildAgentStateTools({
            self: LEADER,
            requestId: OWN_REQUEST_ID,
            reader
          }),
          "read_agent_state"
        ),
        runnableArguments: { code: "lysiptera" },
        invalidArguments: { code: "Lysiptera" },
        countStartedWork: () => reader.findAgentState.mock.calls.length
      }
    })

    it("refuses a value that cannot be an agent code without reading", async () => {
      const reader = createReader({})
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      await expect(
        runStateTool(tools, "read_agent_state", { code: "Lysiptera" })
      ).resolves.toEqual({
        status: "invalid",
        message:
          'The code must be an agent code: lowercase letters and digits in groups joined by single hyphens, such as "caliginia". Use find_agents to look an agent up by name.'
      })
      expect(reader.findAgentState).not.toHaveBeenCalled()
    })

    it("puts an agent name and a conversation title with line breaks on one line", async () => {
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader: createReader({
          state: {
            status: "found",
            state: {
              code: "researcher",
              name: "Web\nresearcher",
              role: "member",
              deletedAt: null,
              requests: [
                buildRequest(104, {
                  conversationTitle: {
                    status: "found",
                    title: "Trip\n to  Kyoto"
                  }
                })
              ]
            }
          }
        })
      })

      const result = await runStateTool(tools, "read_agent_state", {
        code: "researcher"
      })

      expect(result).toMatchObject({
        content: [
          "Web researcher (code researcher) is a member.",
          "Now: 2026-10-24T10:05:30.000Z.",
          "Working on 1 request:",
          `1. In "Trip to Kyoto": started 2026-10-24T10:05:00.000Z (less than a minute ago) with qwen/qwen3-8b; getting ready to answer.`
        ].join("\n")
      })
    })

    it.each<readonly [string, RequestVariation, string]>([
      [
        "in an untitled conversation, thinking",
        {
          conversationTitle: { status: "found", title: null },
          step: { kind: "thinking", round: 0 }
        },
        "In an untitled conversation: started 2026-10-24T10:05:00.000Z (less than a minute ago) with qwen/qwen3-8b; thinking."
      ],
      [
        "in a deleted conversation, writing, a minute in",
        {
          conversationTitle: { status: "missing" },
          startedAt: "2026-10-24T10:04:30.000Z",
          step: { kind: "writing", round: 2 }
        },
        "In a conversation that was deleted: started 2026-10-24T10:04:30.000Z (1 minute ago) with qwen/qwen3-8b; writing the reply."
      ],
      [
        "reading tool results in a later round",
        { step: { kind: "preparing", round: 1 } },
        `In "Trip to Kyoto": started 2026-10-24T10:05:00.000Z (less than a minute ago) with qwen/qwen3-8b; reading tool results.`
      ],
      [
        "with a call of each other status",
        {
          step: {
            kind: "using-tools",
            round: 0,
            toolCalls: [
              buildToolCall(300, "a", "running"),
              buildToolCall(301, "b", "running-in-app"),
              buildToolCall(302, "c", "failed"),
              buildToolCall(303, "d", "rejected"),
              buildToolCall(304, "e", "interrupted")
            ]
          }
        },
        `In "Trip to Kyoto": started 2026-10-24T10:05:00.000Z (less than a minute ago) with qwen/qwen3-8b; using tools: a running, b running in the app, c failed, d rejected by the person, e interrupted.`
      ]
    ])("tells another agent's request %s", async (_label, variation, line) => {
      const reader = createReader({
        state: {
          status: "found",
          state: {
            code: "lysiptera",
            name: "Lysiptera",
            role: "leader",
            deletedAt: null,
            requests: [buildRequest(103, variation)]
          }
        }
      })
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      const result = await runStateTool(tools, "read_agent_state", {
        code: "lysiptera"
      })

      expect(result).toEqual({
        status: "succeeded",
        content: [
          "Lysiptera (code lysiptera) is a leader.",
          "Now: 2026-10-24T10:05:30.000Z.",
          "Working on 1 request:",
          `1. ${line}`
        ].join("\n"),
        sources: []
      })
      expect(reader.findAgentState).toHaveBeenCalledExactlyOnceWith(
        LEADER,
        "lysiptera"
      )
    })

    it("tells an idle, deleted agent's state", async () => {
      const reader = createReader({
        state: {
          status: "found",
          state: {
            code: "researcher",
            name: "Researcher",
            role: "member",
            deletedAt: "2026-10-20T08:00:00.000Z",
            requests: []
          }
        }
      })
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      const result = await runStateTool(tools, "read_agent_state", {
        code: "researcher"
      })

      expect(result).toEqual({
        status: "succeeded",
        content: [
          "Researcher (code researcher) is a member. It was deleted on 2026-10-20T08:00:00.000Z.",
          "Now: 2026-10-24T10:05:30.000Z.",
          "No requests in progress."
        ].join("\n"),
        sources: []
      })
    })

    it("answers a code no agent has with a hint to search", async () => {
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader: createReader({ state: { status: "missing" } })
      })

      await expect(
        runStateTool(tools, "read_agent_state", { code: "nobody" })
      ).resolves.toEqual({
        status: "failed",
        content:
          'No agent has the code "nobody". Use find_agents to look an agent up by name.'
      })
    })

    it("answers a refused read as failed, saying only leaders see other agents", async () => {
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader: createReader({ state: { status: "forbidden" } })
      })

      await expect(
        runStateTool(tools, "read_agent_state", { code: "lysiptera" })
      ).resolves.toEqual({
        status: "failed",
        content: "Only leaders can see other agents."
      })
    })
  })

  describe("find_agents", () => {
    registerBuiltInToolContractSuite(async (): Promise<BuiltInToolHarness> => {
      const reader = createReader({
        search: { status: "found", matches: [], matchCount: 0 }
      })
      return {
        tool: findStateTool(
          buildAgentStateTools({
            self: LEADER,
            requestId: OWN_REQUEST_ID,
            reader
          }),
          "find_agents"
        ),
        runnableArguments: { query: "lys" },
        invalidArguments: { query: " " },
        countStartedWork: () => reader.listAgentMatches.mock.calls.length
      }
    })

    it("lists the matches with their code, role, deletion, and bio on one line, searching the trimmed query", async () => {
      const reader = createReader({
        search: {
          status: "found",
          matches: [
            {
              code: "caliginia",
              name: "Caliginia",
              bio: "Lys's dark side.",
              role: "leader",
              deletedAt: null
            },
            {
              code: "lys-fan",
              name: "Lys fan",
              bio: "Loves Lys.\nAsks a lot.",
              role: "member",
              deletedAt: "2026-10-20T08:00:00.000Z"
            }
          ],
          matchCount: 2
        }
      })
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      const result = await runStateTool(tools, "find_agents", {
        query: "  lys "
      })

      expect(result).toEqual({
        status: "succeeded",
        content: [
          '2 agents match "lys":',
          "- Caliginia (code caliginia), leader: Lys's dark side.",
          "- Lys fan (code lys-fan), member, deleted on 2026-10-20T08:00:00.000Z: Loves Lys. Asks a lot."
        ].join("\n"),
        sources: []
      })
      expect(reader.listAgentMatches).toHaveBeenCalledExactlyOnceWith(
        LEADER,
        "lys"
      )
    })

    it("says how many more matched than it shows", async () => {
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader: createReader({
          search: {
            status: "found",
            matches: [
              {
                code: "caliginia",
                name: "Caliginia",
                bio: "Lys's dark side.",
                role: "leader",
                deletedAt: null
              }
            ],
            matchCount: 3
          }
        })
      })

      const result = await runStateTool(tools, "find_agents", { query: "a" })

      expect(result).toMatchObject({
        content: [
          '3 agents match "a":',
          "- Caliginia (code caliginia), leader: Lys's dark side.",
          "2 more not shown; use a longer query to narrow them."
        ].join("\n")
      })
    })

    it("says so in one sentence when one agent matches, or none", async () => {
      const one = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader: createReader({
          search: {
            status: "found",
            matches: [
              {
                code: "caliginia",
                name: "Caliginia",
                bio: "Lys's dark side.",
                role: "leader",
                deletedAt: null
              }
            ],
            matchCount: 1
          }
        })
      })
      const none = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader: createReader({
          search: { status: "found", matches: [], matchCount: 0 }
        })
      })

      await expect(
        runStateTool(one, "find_agents", { query: "dark" })
      ).resolves.toMatchObject({
        content: expect.stringMatching(/^1 agent matches "dark":\n/)
      })
      await expect(
        runStateTool(none, "find_agents", { query: "ghost" })
      ).resolves.toEqual({
        status: "succeeded",
        content: 'No agent matches "ghost".',
        sources: []
      })
    })

    it.each([
      ["blank", "   "],
      ["longer than 100 characters", "a".repeat(101)],
      ["non-text", 7]
    ])("refuses a %s query without searching", async (_label, query) => {
      const reader = createReader({})
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      await expect(
        runStateTool(tools, "find_agents", { query })
      ).resolves.toEqual({
        status: "invalid",
        message: "The query must be 1 to 100 characters long after trimming."
      })
      expect(reader.listAgentMatches).not.toHaveBeenCalled()
    })

    it("accepts a 100-character query", async () => {
      const reader = createReader({
        search: { status: "found", matches: [], matchCount: 0 }
      })
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader
      })

      await runStateTool(tools, "find_agents", { query: "a".repeat(100) })

      expect(reader.listAgentMatches).toHaveBeenCalledOnce()
    })

    it("answers a refused search as failed, saying only leaders see other agents", async () => {
      const tools = buildAgentStateTools({
        self: LEADER,
        requestId: OWN_REQUEST_ID,
        reader: createReader({ search: { status: "forbidden" } })
      })

      await expect(
        runStateTool(tools, "find_agents", { query: "lys" })
      ).resolves.toEqual({
        status: "failed",
        content: "Only leaders can see other agents."
      })
    })
  })
})
