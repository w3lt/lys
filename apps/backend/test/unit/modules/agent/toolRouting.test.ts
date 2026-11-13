import type { MessageGenerationOptions } from "@lys/protocol"
import { FIND_TOOLS_TOOL_NAME } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import { formatSystemPrompt } from "../../../../src/modules/agent/agentContext"
import { buildAgentStateDefinitions } from "../../../../src/modules/agent/agentStateTools"
import FindToolsTool, {
  FIND_TOOLS_DEFINITION,
  formatToolRoutingNote,
  type ToolKeeper
} from "../../../../src/modules/agent/findToolsTool"
import ReplyToolOffer from "../../../../src/modules/agent/replyToolOffer"
import {
  addFoundTools,
  buildReplyTools,
  calculateToolRouting,
  formatRoutedSystemPrompt,
  listOfferedDefinitions,
  type ReplyToolsTurn,
  type ToolRouting
} from "../../../../src/modules/agent/toolRouting"
import {
  NO_UNOFFERED_TOOLS,
  TOOL_CALLS_OFF
} from "../../../../src/modules/agent/unofferedTools"
import type { TurnMcpTool } from "../../../../src/modules/mcp/mcpServerRegistry"
import type { TurnBuiltInTool } from "../../../../src/modules/tool/builtIn/builtInTool"
import { parseMcpToolDefinition } from "../../support/mcpToolFixtures"
import {
  CHECK_SPELLING_TOOL,
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "../../support/scriptedBuiltInTool"
import {
  buildFoundToolSearchOutcome,
  READ_TEXT_FILE_TOOL,
  RUN_TOOL_CALL_ID,
  TOOL_CALL_POLICY
} from "../../support/toolFixtures"

/**
 * Builds a backend tool of a turn.
 *
 * @param definition - Definition of the tool.
 * @param runsWithoutApproval - Whether its calls run without approval.
 * @returns The tool, run by a scripted word look-up.
 */
function buildTurnTool(
  definition: TurnBuiltInTool["definition"],
  runsWithoutApproval: boolean
): TurnBuiltInTool {
  return Object.freeze({
    definition,
    tool: new ScriptedBuiltInTool(),
    runsWithoutApproval
  })
}

/** State tools of a leader, as a trained turn offers them. */
const STATE_DEFINITIONS = buildAgentStateDefinitions("leader")

/** State tools of the cases. */
const STATE_TOOLS = Object.freeze(
  STATE_DEFINITIONS.map((definition) => buildTurnTool(definition, true))
)

/** Input schema of the MCP tool of the cases: no argument. */
const MCP_INPUT_SCHEMA = Object.freeze({ type: "object", properties: {} })

/** Definition of the MCP tool of the cases. */
const MCP_DEFINITION = parseMcpToolDefinition({
  name: "mcp__files__echo",
  description: "Echoes its text.",
  group: "mcp",
  access: "unknown",
  runner: "mcp",
  server: "files",
  serverToolName: "echo",
  inputSchema: MCP_INPUT_SCHEMA
})

/** MCP tool of the cases. */
const MCP_TOOL: TurnMcpTool = Object.freeze({
  definition: MCP_DEFINITION,
  isDestructive: false,
  sendToolCall: async () => ({ status: "succeeded" as const, content: "echo" })
})

/** Routing of a turn that offers every tool from the first round. */
const DIRECT_ROUTING: ToolRouting = Object.freeze({ status: "direct" })

/**
 * Creates a keeper that finds the client tool for every task.
 *
 * @returns The keeper, whose search records each call.
 */
function createKeeper() {
  return {
    findTools: vi.fn<ToolKeeper["findTools"]>(async () =>
      buildFoundToolSearchOutcome([READ_TEXT_FILE_TOOL.name])
    )
  } satisfies ToolKeeper
}

/**
 * Builds the turn of a reply's tools.
 *
 * @param trainedForToolUse - Whether the model is trained for tool use.
 * @returns A turn with a direct tool that is offered in every round, a
 * client, a built-in, and an MCP tool.
 */
function buildTurn(trainedForToolUse: boolean): ReplyToolsTurn {
  const generationOptions: MessageGenerationOptions = { temperature: 0.7 }
  return {
    conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
    model: "qwen/qwen3-8b",
    trainedForToolUse,
    generationOptions,
    directTools: [buildTurnTool(CHECK_SPELLING_TOOL, true)],
    clientTools: [READ_TEXT_FILE_TOOL],
    builtInTools: [buildTurnTool(LOOK_UP_WORD_TOOL, false)],
    mcpTools: [MCP_TOOL],
    reportToolSearchFailure: vi.fn(),
    toolCallPolicy: TOOL_CALL_POLICY
  }
}

/**
 * Builds the tools of a routed reply.
 *
 * @param keeper - Keeper the reply's `find_tools` asks.
 * @returns The reply's tools, of a turn whose model is trained for tool use.
 * @throws If the turn was not routed.
 */
function buildRoutedReplyTools(keeper: ToolKeeper) {
  const replyTools = buildReplyTools(buildTurn(true), STATE_TOOLS, keeper)
  if (replyTools.status !== "routed") throw new Error("The turn is not routed")
  return replyTools
}

describe("calculateToolRouting", () => {
  it("routes the tools of a model trained for tool use through find_tools", () => {
    expect(calculateToolRouting(true, 3)).toEqual({
      status: "routed",
      toolCount: 3
    })
  })

  it.each([
    ["a model not trained for tool use", false, 3],
    ["a turn without tools to keep", true, 0]
  ])("offers the tools directly for %s", (_label, trained, toolCount) => {
    expect(calculateToolRouting(trained, toolCount)).toEqual({
      status: "direct"
    })
  })
})

describe("formatRoutedSystemPrompt", () => {
  it("formats the prompt as a turn without routing does", () => {
    expect(
      formatRoutedSystemPrompt("You are Lys.", TOOL_CALLS_OFF, DIRECT_ROUTING)
    ).toBe(formatSystemPrompt("You are Lys.", TOOL_CALLS_OFF))
  })

  it("ends a routed prompt with the routing note after a blank line", () => {
    expect(
      formatRoutedSystemPrompt("You are Lys.", NO_UNOFFERED_TOOLS, {
        status: "routed",
        toolCount: 4
      })
    ).toBe(`You are Lys.\n\n${formatToolRoutingNote(4)}`)
  })
})

describe("listOfferedDefinitions", () => {
  const input = {
    directTools: [CHECK_SPELLING_TOOL],
    tools: [READ_TEXT_FILE_TOOL, LOOK_UP_WORD_TOOL],
    agentStateTools: STATE_DEFINITIONS
  }

  it("lists the direct tools, the turn's tools, then the state tools", () => {
    expect(
      listOfferedDefinitions({ ...input, routing: DIRECT_ROUTING })
    ).toEqual([
      CHECK_SPELLING_TOOL,
      READ_TEXT_FILE_TOOL,
      LOOK_UP_WORD_TOOL,
      ...STATE_DEFINITIONS
    ])
  })

  it("lists find_tools in place of a routed turn's tools", () => {
    const routing: ToolRouting = { status: "routed", toolCount: 2 }

    expect(listOfferedDefinitions({ ...input, routing })).toEqual([
      CHECK_SPELLING_TOOL,
      FIND_TOOLS_DEFINITION,
      ...STATE_DEFINITIONS
    ])
  })
})

describe("buildReplyTools", () => {
  it("offers every tool from the first round when the model is not trained for tool use", () => {
    const replyTools = buildReplyTools(
      buildTurn(false),
      STATE_TOOLS,
      createKeeper()
    )

    expect(replyTools).toEqual({
      status: "direct",
      toolOffer: expect.any(ReplyToolOffer)
    })
    expect([...replyTools.toolOffer.listOfferedToolset().keys()]).toEqual([
      CHECK_SPELLING_TOOL.name,
      READ_TEXT_FILE_TOOL.name,
      LOOK_UP_WORD_TOOL.name,
      MCP_TOOL.definition.name,
      ...STATE_DEFINITIONS.map((definition) => definition.name)
    ])
  })

  it("offers a routed reply its direct tools, find_tools, and its state tools from the first round", () => {
    const replyTools = buildRoutedReplyTools(createKeeper())

    expect(replyTools).toEqual({
      status: "routed",
      toolCount: 3,
      toolOffer: expect.any(ReplyToolOffer),
      findTools: expect.any(FindToolsTool)
    })
    expect([...replyTools.toolOffer.listOfferedToolset().keys()]).toEqual([
      CHECK_SPELLING_TOOL.name,
      FIND_TOOLS_TOOL_NAME,
      ...STATE_DEFINITIONS.map((definition) => definition.name)
    ])
    expect(
      replyTools.toolOffer.listOfferedToolset().get(FIND_TOOLS_TOOL_NAME)
    ).toMatchObject({ runner: "backend", runsWithoutApproval: true })
  })

  it("offers a found tool of the turn once added, as the turn's toolset holds it", async () => {
    const keeper = createKeeper()
    const replyTools = buildRoutedReplyTools(keeper)
    const parsed = replyTools.findTools.parseToolCall({ task: "read a file" })
    if (parsed.status !== "parsed") throw new Error("find_tools did not parse")
    await parsed.runToolCall({
      toolCallId: RUN_TOOL_CALL_ID,
      abortSignal: new AbortController().signal,
      addWebSources: () => []
    })

    addFoundTools(replyTools)

    expect([...replyTools.toolOffer.listOfferedToolset().keys()]).toEqual([
      CHECK_SPELLING_TOOL.name,
      FIND_TOOLS_TOOL_NAME,
      READ_TEXT_FILE_TOOL.name,
      ...STATE_DEFINITIONS.map((definition) => definition.name)
    ])
    expect(keeper.findTools).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "read a file",
        tools: [READ_TEXT_FILE_TOOL, LOOK_UP_WORD_TOOL, MCP_TOOL.definition],
        model: "qwen/qwen3-8b"
      })
    )
  })

  it("offers a trained turn without tools to keep everything it has, without find_tools", () => {
    const turn = {
      ...buildTurn(true),
      clientTools: [],
      builtInTools: [],
      mcpTools: []
    }

    const replyTools = buildReplyTools(turn, STATE_TOOLS, createKeeper())

    expect(replyTools).toEqual({
      status: "direct",
      toolOffer: expect.any(ReplyToolOffer)
    })
    addFoundTools(replyTools)
    expect([...replyTools.toolOffer.listOfferedToolset().keys()]).toEqual([
      CHECK_SPELLING_TOOL.name,
      ...STATE_DEFINITIONS.map((definition) => definition.name)
    ])
  })
})
