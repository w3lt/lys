import { describe, expect, it, vi } from "vitest"
import {
  findRequestedBackendTools,
  sendUnansweredTurnProblem,
  UnknownBackendToolError
} from "../../../../../src/modules/chat/routes/turnRequest"
import type {
  McpTurnToolLookup,
  TurnMcpTool
} from "../../../../../src/modules/mcp/mcpServerRegistry"
import type { BuiltInToolEntry } from "../../../../../src/modules/tool/builtIn/builtInTool"
import {
  CHECK_SPELLING_TOOL,
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "../../../support/scriptedBuiltInTool"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { createTestFastify } from "../../../support/fastifyTestApp"
import { parseMcpToolDefinition } from "../../../support/mcpToolFixtures"
import { ScriptedBuiltInToolProvider } from "../../../support/scriptedBuiltInToolProvider"

/** Every built-in tool of the cases. */
const BUILT_IN_TOOLS: readonly BuiltInToolEntry[] = Object.freeze([
  Object.freeze({
    definition: LOOK_UP_WORD_TOOL,
    provider: new ScriptedBuiltInToolProvider({
      status: "ready",
      tool: new ScriptedBuiltInTool()
    })
  }),
  Object.freeze({
    definition: CHECK_SPELLING_TOOL,
    provider: new ScriptedBuiltInToolProvider({
      status: "unavailable",
      reason: "api-key-missing"
    })
  })
])

/** The connected `files` server's echo tool. */
const ECHO_TOOL: TurnMcpTool = Object.freeze({
  definition: parseMcpToolDefinition({
    name: "mcp__files__echo",
    description: "Echoes its text.",
    group: "mcp",
    access: "unknown",
    runner: "mcp",
    server: "files",
    serverToolName: "echo",
    inputSchema: { type: "object" }
  }),
  isDestructive: false,
  isOpenWorldWrite: false,
  isLysOnly: false,
  sendToolCall: () => Promise.reject(new Error("Unexpected MCP call"))
})

/**
 * Builds an MCP tool lookup over a connected `files` server that lists the
 * echo tool, and a `notes` server that is not connected.
 *
 * @returns A spy over the lookups.
 */
function createMcpToolLookup() {
  return vi.fn<(toolName: string) => McpTurnToolLookup>((toolName) => {
    if (toolName === ECHO_TOOL.definition.name)
      return { status: "found", tool: ECHO_TOOL }
    if (toolName.startsWith("mcp__notes__")) return { status: "not-connected" }
    return { status: "unknown" }
  })
}

describe("findRequestedBackendTools", () => {
  it("finds the offered built-in and MCP tools by kind, each in offer order", () => {
    const findMcpTool = createMcpToolLookup()

    const found = findRequestedBackendTools(BUILT_IN_TOOLS, findMcpTool, {
      definitions: [],
      backendToolNames: ["mcp__files__echo", "check_spelling", "look_up_word"]
    })

    expect(found).toEqual({
      builtInTools: [BUILT_IN_TOOLS[1], BUILT_IN_TOOLS[0]],
      mcpTools: [ECHO_TOOL],
      notConnectedMcpToolName: undefined,
      offersDelegateWork: false
    })
    expect(findMcpTool.mock.calls).toEqual([["mcp__files__echo"]])
  })

  it("offers nothing for a request without a tool offer", () => {
    expect(
      findRequestedBackendTools(
        BUILT_IN_TOOLS,
        createMcpToolLookup(),
        undefined
      )
    ).toEqual({
      builtInTools: [],
      mcpTools: [],
      notConnectedMcpToolName: undefined,
      offersDelegateWork: false
    })
  })

  it("says that a request offers delegate_work, and looks the name up among neither the built-in nor the MCP tools", () => {
    const findMcpTool = createMcpToolLookup()

    const found = findRequestedBackendTools(BUILT_IN_TOOLS, findMcpTool, {
      definitions: [],
      backendToolNames: ["look_up_word", "delegate_work", "mcp__files__echo"]
    })

    expect(found).toEqual({
      builtInTools: [BUILT_IN_TOOLS[0]],
      mcpTools: [ECHO_TOOL],
      notConnectedMcpToolName: undefined,
      offersDelegateWork: true
    })
    expect(findMcpTool.mock.calls).toEqual([["mcp__files__echo"]])
  })

  it("names the first offered MCP tool whose server is not connected", () => {
    const found = findRequestedBackendTools(
      BUILT_IN_TOOLS,
      createMcpToolLookup(),
      {
        definitions: [],
        backendToolNames: [
          "mcp__files__echo",
          "mcp__notes__read",
          "mcp__notes__write"
        ]
      }
    )

    expect(found).toMatchObject({
      mcpTools: [ECHO_TOOL],
      notConnectedMcpToolName: "mcp__notes__read"
    })
  })

  it("throws naming every unknown name in offer order, even with a server that is not connected, and looks up only MCP names in the servers", () => {
    const findMcpTool = createMcpToolLookup()

    expect(() =>
      findRequestedBackendTools(BUILT_IN_TOOLS, findMcpTool, {
        definitions: [],
        backendToolNames: [
          "fetch_url",
          "mcp__notes__read",
          "mcp__files__delete",
          "look_up_word"
        ]
      })
    ).toThrow(new UnknownBackendToolError(["fetch_url", "mcp__files__delete"]))
    expect(findMcpTool.mock.calls).toEqual([
      ["mcp__notes__read"],
      ["mcp__files__delete"]
    ])
  })
})

describe("sendUnansweredTurnProblem", () => {
  it("sends the is-job problem with a 409 for a turn that continues a job", async () => {
    const { app } = createTestFastify()
    const conversationId = createFixtureUuidV7(7)
    app.post("/api/v1/chat", (request, reply) => {
      sendUnansweredTurnProblem(
        reply,
        { status: "conversation-is-job", conversationId },
        request.url
      )
    })

    const response = await app.inject({ method: "POST", url: "/api/v1/chat" })

    expect(response.statusCode).toBe(409)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(response.json()).toEqual({
      type: "urn:lys:problem:conversation:is-job",
      title: "Conversation is a job",
      status: 409,
      detail: `Conversation ${conversationId} is a job. A job can be read and stopped, and nothing else.`,
      instance: "/api/v1/chat"
    })
  })
})
