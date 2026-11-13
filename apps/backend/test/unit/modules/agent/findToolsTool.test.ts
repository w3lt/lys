import type { MessageGenerationOptions } from "@lys/protocol"
import {
  FIND_TOOLS_TOOL_NAME,
  toolDefinitionSchema,
  type ToolDefinition
} from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import FindToolsTool, {
  FIND_TOOLS_DEFINITION,
  formatToolRoutingNote,
  type FindToolsContext,
  type ToolKeeper,
  type ToolSearch,
  type ToolSearchOutcome
} from "../../../../src/modules/agent/findToolsTool"
import type { BuiltInToolResult } from "../../../../src/modules/tool/builtIn/builtInTool"
import {
  registerBuiltInToolContractSuite,
  type BuiltInToolHarness
} from "../../support/builtInToolContract"
import {
  buildFoundToolSearchOutcome,
  RUN_TOOL_CALL_ID,
  TOOL_CALL_POLICY
} from "../../support/toolFixtures"

/**
 * Builds the definition of a backend tool that takes no argument.
 *
 * @param name - Name of the tool.
 * @returns The validated definition.
 */
function buildDefinition(name: string): ToolDefinition {
  return toolDefinitionSchema.parse({
    name,
    description: `Runs ${name}.`,
    group: "network",
    access: "network",
    runner: "backend",
    arguments: []
  })
}

/** Tools of the asking turn, in offer order. */
const TOOLS = Object.freeze([
  buildDefinition("read_page"),
  buildDefinition("send_email")
])

/**
 * Fails a case whose search reports a failure the case did not arrange.
 *
 * @param failure - The reported failure.
 * @throws Always.
 */
function reportUnexpectedFailure(failure: unknown): never {
  throw new Error("Unexpected search failure", { cause: failure })
}

/**
 * Creates a keeper that answers every search with one outcome.
 *
 * @param outcome - Outcome of every search.
 * @returns The keeper, whose search records each call.
 */
function createKeeper(outcome: ToolSearchOutcome) {
  return {
    findTools: vi.fn<ToolKeeper["findTools"]>(async (search: ToolSearch) => {
      search.abortSignal.throwIfAborted()
      return outcome
    })
  } satisfies ToolKeeper
}

/**
 * Builds the context of `find_tools` for one reply.
 *
 * @param keeper - Keeper of the case.
 * @param reportFailure - Receives why a search ended without finding; by
 * default it fails the case.
 * @returns The context over {@link TOOLS}.
 */
function buildContext(
  keeper: ToolKeeper,
  reportFailure: FindToolsContext["reportFailure"] = reportUnexpectedFailure
): FindToolsContext {
  const generationOptions: MessageGenerationOptions = { temperature: 0.4 }
  return {
    keeper,
    tools: TOOLS,
    conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
    model: "qwen/qwen3-8b",
    generationOptions,
    reportFailure,
    toolCallPolicy: TOOL_CALL_POLICY
  }
}

/**
 * Creates `find_tools` over a keeper that finds the page reader.
 *
 * @returns The contract harness, counting the keeper's searches.
 */
async function createFindToolsHarness(): Promise<BuiltInToolHarness> {
  const keeper = createKeeper(buildFoundToolSearchOutcome(["read_page"]))
  return {
    tool: new FindToolsTool(buildContext(keeper)),
    runnableArguments: { task: "read a web page" },
    invalidArguments: { task: "  " },
    countStartedWork: () => keeper.findTools.mock.calls.length
  }
}

/**
 * Runs one call of `find_tools`.
 *
 * @param tool - The reply's `find_tools`.
 * @param task - Task the call names.
 * @param abortSignal - Signal of the run.
 * @returns The run's result.
 * @throws If the task does not parse.
 */
async function runFindTools(
  tool: FindToolsTool,
  task: string,
  abortSignal = new AbortController().signal
): Promise<BuiltInToolResult> {
  const parsed = tool.parseToolCall({ task })
  if (parsed.status !== "parsed") throw new Error(parsed.message)
  return await parsed.runToolCall({
    toolCallId: RUN_TOOL_CALL_ID,
    abortSignal,
    addWebSources: () => []
  })
}

describe("FIND_TOOLS_DEFINITION", () => {
  it("defines find_tools, reading this machine in the backend, with a task", () => {
    expect(FIND_TOOLS_DEFINITION).toMatchObject({
      name: FIND_TOOLS_TOOL_NAME,
      group: "agents",
      access: "reads",
      runner: "backend",
      arguments: [expect.objectContaining({ type: "string", name: "task" })]
    })
  })
})

describe("formatToolRoutingNote", () => {
  it.each([
    ["1 tool", 1],
    ["12 tools", 12]
  ])("counts %s and tells the model to call find_tools", (tools, count) => {
    expect(formatToolRoutingNote(count)).toBe(
      `You have ${tools} that Armitage, the tool keeper, keeps for you. Before you use one, call find_tools with what you need a tool for, such as "read a web page"; the tools Armitage finds are offered to you from your next step.`
    )
  })
})

describe("FindToolsTool", () => {
  registerBuiltInToolContractSuite(createFindToolsHarness)

  it("asks the keeper with the trimmed task, the running call as the search's call, the turn's tools, and the run's signal", async () => {
    const keeper = createKeeper(buildFoundToolSearchOutcome([]))
    const abortSignal = new AbortController().signal

    const context = buildContext(keeper)

    await runFindTools(
      new FindToolsTool(context),
      "  read a web page ",
      abortSignal
    )

    expect(keeper.findTools).toHaveBeenCalledWith({
      task: "read a web page",
      searchCallId: RUN_TOOL_CALL_ID,
      tools: TOOLS,
      conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
      model: "qwen/qwen3-8b",
      generationOptions: context.generationOptions,
      abortSignal,
      reportFailure: reportUnexpectedFailure,
      toolCallPolicy: TOOL_CALL_POLICY
    })
  })

  it("names the tools the keeper found and keeps them for the reply's next round", async () => {
    const tool = new FindToolsTool(
      buildContext(
        createKeeper(buildFoundToolSearchOutcome(["send_email", "read_page"]))
      )
    )

    const result = await runFindTools(tool, "email a page")

    expect(result).toEqual({
      status: "succeeded",
      content:
        "Armitage found these tools for the task, and you can call them from your next step: send_email, read_page.",
      sources: []
    })
    expect(tool.listFoundToolNames()).toEqual(["send_email", "read_page"])
  })

  it("keeps every tool found across the reply's calls, each once, in the order found", async () => {
    const keeper = createKeeper(buildFoundToolSearchOutcome(["read_page"]))
    const tool = new FindToolsTool(buildContext(keeper))
    await runFindTools(tool, "read a page")
    keeper.findTools.mockResolvedValueOnce(
      buildFoundToolSearchOutcome(["send_email", "read_page"])
    )

    await runFindTools(tool, "send an email")

    expect(tool.listFoundToolNames()).toEqual(["read_page", "send_email"])
  })

  it("says when the keeper found no tool, offering nothing", async () => {
    const tool = new FindToolsTool(
      buildContext(createKeeper(buildFoundToolSearchOutcome([])))
    )

    const result = await runFindTools(tool, "book a flight")

    expect(result).toEqual({
      status: "succeeded",
      content:
        "Armitage found no tool for this task. Describe the task in other words, or tell the person you have no tool for it.",
      sources: []
    })
    expect(tool.listFoundToolNames()).toEqual([])
  })

  it("fails closed when the keeper could not search, offering nothing, and lends the keeper the reply's failure receiver", async () => {
    const failure = new Error("Armitage's model failed")
    const keeper: ToolKeeper = {
      findTools: async (search) => {
        search.reportFailure(failure)
        return { status: "failed" }
      }
    }
    const reportFailure = vi.fn()
    const tool = new FindToolsTool(buildContext(keeper, reportFailure))

    const result = await runFindTools(tool, "read a page")

    expect(result).toEqual({
      status: "failed",
      content:
        "Armitage could not search the tools now. Try again, or go on without a tool."
    })
    expect(tool.listFoundToolNames()).toEqual([])
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it("rejects with the abort reason when stopped during the search, offering nothing", async () => {
    const stopReason = new Error("stopped")
    const abortController = new AbortController()
    const keeper: ToolKeeper = {
      findTools: async (search) => {
        abortController.abort(stopReason)
        search.abortSignal.throwIfAborted()
        return buildFoundToolSearchOutcome(["read_page"])
      }
    }
    const tool = new FindToolsTool(buildContext(keeper))

    await expect(
      runFindTools(tool, "read a page", abortController.signal)
    ).rejects.toBe(stopReason)
    expect(tool.listFoundToolNames()).toEqual([])
  })

  it("rejects with the abort reason when stopped just after the keeper found tools, offering nothing", async () => {
    const stopReason = new Error("stopped")
    const abortController = new AbortController()
    const search = Promise.withResolvers<ToolSearchOutcome>()
    const tool = new FindToolsTool(
      buildContext({ findTools: () => search.promise })
    )
    const run = runFindTools(tool, "read a page", abortController.signal)

    search.resolve(buildFoundToolSearchOutcome(["read_page"]))
    abortController.abort(stopReason)

    await expect(run).rejects.toBe(stopReason)
    expect(tool.listFoundToolNames()).toEqual([])
  })

  it("asks the keeper with a task of 500 characters after trimming", async () => {
    const keeper = createKeeper(buildFoundToolSearchOutcome([]))
    const task = "a".repeat(500)

    await runFindTools(new FindToolsTool(buildContext(keeper)), ` ${task} `)

    expect(keeper.findTools).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ task })
    )
  })

  it.each([
    ["a blank task", "   "],
    ["a task of more than 500 characters", "a".repeat(501)]
  ])("refuses %s without asking the keeper", (_label, task) => {
    const keeper = createKeeper(buildFoundToolSearchOutcome([]))

    const parsed = new FindToolsTool(buildContext(keeper)).parseToolCall({
      task
    })

    expect(parsed).toEqual({
      status: "invalid",
      message: "The task must be 1 to 500 characters long after trimming."
    })
    expect(keeper.findTools).not.toHaveBeenCalled()
  })
})
