import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
import { describe, expect, it } from "vitest"
import ReplyToolOffer from "../../../../src/modules/agent/replyToolOffer"
import {
  buildAgentToolset,
  type AgentToolset
} from "../../../../src/modules/agent/toolCallRound"
import AgentTool from "../../../../src/modules/tool/tool"

/**
 * Builds the definition of a client tool that takes no argument.
 *
 * @param name - Name of the tool.
 * @returns The validated definition.
 */
function buildClientDefinition(name: string): ToolDefinition {
  return toolDefinitionSchema.parse({
    name,
    description: `Runs ${name}.`,
    group: "files",
    access: "reads",
    runner: "client",
    arguments: []
  })
}

/**
 * Builds the toolset of every case's turn.
 *
 * @returns The client tools `first_tool`, `second_tool`, and `third_tool`,
 * in offer order.
 */
function buildTurnToolset(): AgentToolset {
  return buildAgentToolset({
    directTools: [],
    clientTools: ["first_tool", "second_tool", "third_tool"].map(
      buildClientDefinition
    ),
    builtInTools: [],
    mcpTools: [],
    agentStateTools: []
  })
}

/**
 * Lists the function tool names an offer sends.
 *
 * @param offer - The reply's offer.
 * @returns The names, in offer order.
 */
function listFunctionToolNames(offer: ReplyToolOffer): readonly string[] {
  return offer.listOfferedTools().map((tool) => tool.function.name)
}

/**
 * Lists the names of the tools a round answers calls of.
 *
 * @param offer - The reply's offer.
 * @returns The names of its offered toolset, in its order.
 */
function listOfferedToolNames(offer: ReplyToolOffer): readonly string[] {
  return [...offer.listOfferedToolset().keys()]
}

describe("ReplyToolOffer", () => {
  it("offers the tools it starts with, in the turn's order, as function tools", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), [
      "third_tool",
      "first_tool"
    ])

    expect(listOfferedToolNames(offer)).toEqual(["first_tool", "third_tool"])
    expect(offer.listOfferedTools()).toEqual(
      ["first_tool", "third_tool"].map((name) =>
        new AgentTool(buildClientDefinition(name)).buildAgentFormat()
      )
    )
  })

  it("offers every tool of the turn when it starts with all their names", () => {
    const tools = buildTurnToolset()

    const offer = new ReplyToolOffer(tools, tools.keys())

    expect(listOfferedToolNames(offer)).toEqual([
      "first_tool",
      "second_tool",
      "third_tool"
    ])
  })

  it("adds tools of the turn in the turn's order, each once", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), ["third_tool"])

    offer.addTools(["second_tool", "third_tool", "second_tool"])

    expect(listOfferedToolNames(offer)).toEqual(["second_tool", "third_tool"])
    expect(listFunctionToolNames(offer)).toEqual(["second_tool", "third_tool"])
  })

  it("ignores names that are not tools of the turn, at the start and when added", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), [
      "first_tool",
      "unknown_tool"
    ])

    offer.addTools(["other_tool"])

    expect(listOfferedToolNames(offer)).toEqual(["first_tool"])
  })

  it("offers nothing when it starts with no name", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), [])

    expect(listOfferedToolNames(offer)).toEqual([])
    expect(offer.listOfferedTools()).toEqual([])
  })

  it("hands out the offered tools as the turn's toolset holds them", () => {
    const tools = buildTurnToolset()
    const offer = new ReplyToolOffer(tools, ["second_tool"])

    expect(offer.listOfferedToolset().get("second_tool")).toBe(
      tools.get("second_tool")
    )
  })

  it("returns lists and toolsets that later additions leave as they were", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), ["first_tool"])
    const toolset = offer.listOfferedToolset()
    const tools = offer.listOfferedTools()

    offer.addTools(["second_tool"])

    expect(Object.isFrozen(tools)).toBe(true)
    expect([...toolset.keys()]).toEqual(["first_tool"])
    expect(tools).toHaveLength(1)
  })
})
