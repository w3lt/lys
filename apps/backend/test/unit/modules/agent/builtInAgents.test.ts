import {
  ARMITAGE_AGENT_CODE,
  CALIGINIA_AGENT_CODE,
  LYSIPTERA_AGENT_CODE
} from "@lys/share"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  buildBuiltInAgents,
  listAgentMcpTools
} from "../../../../src/modules/agent/builtInAgents"
import type { TurnMcpTool } from "../../../../src/modules/mcp/mcpServerRegistry"
import { parseMcpToolDefinition } from "../../support/mcpToolFixtures"

/** Valid system prompts of the built-in agents. */
const PROMPTS = Object.freeze({
  caliginia: "You are Caliginia.",
  lysiptera: "You are Lysiptera.",
  armitage: "You are Armitage."
})

describe("buildBuiltInAgents", () => {
  it("builds Caliginia, Lysiptera, then Armitage, each with its own prompt", () => {
    expect(buildBuiltInAgents(PROMPTS)).toEqual([
      {
        code: CALIGINIA_AGENT_CODE,
        name: "Caliginia",
        bio: "Lys's dark side.",
        systemPrompt: "You are Caliginia."
      },
      {
        code: LYSIPTERA_AGENT_CODE,
        name: "Lysiptera",
        bio: "Lys's light side.",
        systemPrompt: "You are Lysiptera."
      },
      {
        code: ARMITAGE_AGENT_CODE,
        name: "Armitage",
        bio: "Lys's tool keeper. It finds the tools the other agents need and answers agents, not chats.",
        systemPrompt: "You are Armitage."
      }
    ])
  })

  it("returns frozen agents in a frozen list", () => {
    const builtInAgents = buildBuiltInAgents(PROMPTS)

    expect(Object.isFrozen(builtInAgents)).toBe(true)
    expect(builtInAgents.every((agent) => Object.isFrozen(agent))).toBe(true)
  })

  it.each([
    ["an empty Caliginia prompt", { ...PROMPTS, caliginia: "" }],
    ["a padded Lysiptera prompt", { ...PROMPTS, lysiptera: " padded " }],
    ["an empty Armitage prompt", { ...PROMPTS, armitage: "" }]
  ])("rejects %s", (_label, prompts) => {
    expect(() => buildBuiltInAgents(prompts)).toThrow(z.ZodError)
  })
})

/**
 * Builds an email server's tool found for a turn, whose calls fail the case.
 *
 * @param serverToolName - The tool's name on the server.
 * @param isLysOnly - Whether only Lys herself may use it.
 * @returns The frozen tool.
 */
function buildEmailTool(
  serverToolName: string,
  isLysOnly: boolean
): TurnMcpTool {
  return Object.freeze({
    definition: parseMcpToolDefinition({
      name: `mcp__email__${serverToolName}`,
      description: "Works on a mailbox.",
      group: "mcp",
      access: "unknown",
      runner: "mcp",
      server: "email",
      serverToolName,
      inputSchema: { type: "object" }
    }),
    isDestructive: false,
    isOpenWorldWrite: false,
    isLysOnly,
    sendToolCall: () => Promise.reject(new Error("Unexpected MCP call"))
  })
}

describe("listAgentMcpTools", () => {
  /** The person's send tool, then Lys's, then the person's read tool. */
  const TOOLS = Object.freeze([
    buildEmailTool("send_email", false),
    buildEmailTool("lys_send_email", true),
    buildEmailTool("read_email", false)
  ])

  it.each([CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE])(
    "gives %s every tool, Lys's own included",
    (code) => {
      expect(listAgentMcpTools(code, TOOLS)).toBe(TOOLS)
    }
  )

  it.each([ARMITAGE_AGENT_CODE, "helper"])(
    "gives %s every tool but those only Lys may use, in order, in a frozen list",
    (code) => {
      const tools = listAgentMcpTools(code, TOOLS)

      expect(tools.map((tool) => tool.definition.name)).toEqual([
        "mcp__email__send_email",
        "mcp__email__read_email"
      ])
      expect(Object.isFrozen(tools)).toBe(true)
    }
  )
})
