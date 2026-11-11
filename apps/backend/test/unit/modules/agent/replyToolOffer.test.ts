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

/** Client tools of every case's turn, in offer order. */
const CLIENT_DEFINITIONS = Object.freeze(
  ["first_tool", "second_tool", "third_tool"].map(buildClientDefinition)
)

/**
 * Builds the toolset of every case's turn.
 *
 * @returns The three client tools, in offer order.
 */
function buildTurnToolset(): AgentToolset {
  return buildAgentToolset({
    clientTools: CLIENT_DEFINITIONS,
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

describe("ReplyToolOffer", () => {
  it("offers the tools it starts with, in the turn's order, as function tools", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), [
      "third_tool",
      "first_tool"
    ])

    expect(offer.listOfferedToolNames()).toEqual(["first_tool", "third_tool"])
    expect(offer.listOfferedTools()).toEqual(
      ["first_tool", "third_tool"].map((name) =>
        new AgentTool(buildClientDefinition(name)).buildAgentFormat()
      )
    )
  })

  it("offers every tool of the turn when it starts with all their names", () => {
    const tools = buildTurnToolset()

    const offer = new ReplyToolOffer(tools, tools.keys())

    expect(offer.listOfferedToolNames()).toEqual([
      "first_tool",
      "second_tool",
      "third_tool"
    ])
  })

  it("adds tools of the turn in the turn's order, each once", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), ["third_tool"])

    offer.addTools(["second_tool", "third_tool", "second_tool"])

    expect(offer.listOfferedToolNames()).toEqual(["second_tool", "third_tool"])
    expect(listFunctionToolNames(offer)).toEqual(["second_tool", "third_tool"])
  })

  it("ignores names that are not tools of the turn, at the start and when added", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), [
      "first_tool",
      "unknown_tool"
    ])

    offer.addTools(["other_tool"])

    expect(offer.listOfferedToolNames()).toEqual(["first_tool"])
  })

  it("offers nothing when it starts with no name", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), [])

    expect(offer.listOfferedToolNames()).toEqual([])
    expect(offer.listOfferedTools()).toEqual([])
  })

  it("returns frozen lists that later additions leave as they were", () => {
    const offer = new ReplyToolOffer(buildTurnToolset(), ["first_tool"])
    const names = offer.listOfferedToolNames()
    const tools = offer.listOfferedTools()

    offer.addTools(["second_tool"])

    expect(Object.isFrozen(names)).toBe(true)
    expect(Object.isFrozen(tools)).toBe(true)
    expect(names).toEqual(["first_tool"])
    expect(tools).toHaveLength(1)
  })
})
