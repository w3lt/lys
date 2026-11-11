import { ARMITAGE_AGENT_CODE, toolDefinitionSchema } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import Agent, { type AgentProfile } from "../../../../src/modules/agent/agent"
import type { AgentRequestState } from "../../../../src/modules/agent/agentActivity"
import type { AgentStateReader } from "../../../../src/modules/agent/agentStateTools"
import type {
  ToolKeeper,
  ToolSearch
} from "../../../../src/modules/agent/findToolsTool"
import type { ReplyContextMeter } from "../../../../src/modules/agent/replyContextMeter"
import type {
  ReplyModel,
  ReplyStreamEvent
} from "../../../../src/modules/agent/replyModel"
import {
  RECOMMEND_TOOL_TOOL_NAME,
  SEARCH_TOOLS_TOOL_NAME
} from "../../../../src/modules/agent/toolKeeperTools"
import {
  MAXIMUM_TOOL_KEEPER_ROUND_COUNT,
  runToolKeeperSearch
} from "../../../../src/modules/agent/toolKeeperSearch"
import { ChatCompletionCancelledError } from "../../../../src/utils/errors"
import {
  createRoomyReplyContextMeter,
  createUnloadedReplyContextMeter
} from "../../support/replyContextMeterFakes"

/** Opens one round's stream. */
type OpenReplyStream = ReplyModel["openReplyStream"]

/** System prompt of Armitage in every case. */
const ARMITAGE_PROMPT = "You are Armitage, the tool keeper."

/** Request limits of Armitage in every case. */
const REQUEST_LIMITS = Object.freeze({ slotCount: 2, waitingLimit: 2 })

/** Armitage's profile in every case. */
const ARMITAGE_PROFILE: AgentProfile = Object.freeze({
  code: ARMITAGE_AGENT_CODE,
  role: "tool-keeper",
  systemPrompt: ARMITAGE_PROMPT,
  requestLimits: REQUEST_LIMITS
})

/**
 * Fails a read the case did not arrange.
 *
 * @throws Always.
 */
function handleUnexpectedRead(): never {
  throw new Error("Unexpected read")
}

/** State reader Armitage never uses: it has no state tools. */
const UNEXPECTED_STATE_READER: AgentStateReader = Object.freeze({
  listAgentMatches: handleUnexpectedRead,
  findAgentState: handleUnexpectedRead
})

/** Keeper Armitage never asks: its own turns are never routed. */
const UNEXPECTED_KEEPER: ToolKeeper = Object.freeze({
  findTools: handleUnexpectedRead
})

/** Tools of the asking turn. */
const TOOLS = Object.freeze([
  toolDefinitionSchema.parse({
    name: "read_page",
    description: "Reads one web page and returns its text.",
    group: "network",
    access: "network",
    runner: "backend",
    arguments: []
  }),
  toolDefinitionSchema.parse({
    name: "send_email",
    description: "Sends an email message.",
    group: "network",
    access: "network",
    runner: "backend",
    arguments: []
  })
])

/**
 * Builds a round in which the model calls one tool.
 *
 * @param toolName - Name of the tool.
 * @param callArguments - Arguments of the call.
 * @returns The round's events.
 */
function buildToolCallRound(
  toolName: string,
  callArguments: Readonly<Record<string, string>>
): readonly ReplyStreamEvent[] {
  const toolCall = { toolName, argumentText: JSON.stringify(callArguments) }
  return [{ type: "tool-calls", toolCalls: [toolCall] }]
}

/** Round that searches for a web page reader. */
const SEARCH_ROUND = buildToolCallRound(SEARCH_TOOLS_TOOL_NAME, {
  query: "web page"
})

/** Round that recommends the page reader. */
const RECOMMEND_ROUND = buildToolCallRound(RECOMMEND_TOOL_TOOL_NAME, {
  name: "read_page"
})

/** Round that ends the search with one sentence. */
const FINISH_ROUND: readonly ReplyStreamEvent[] = Object.freeze([
  { type: "text", content: "read_page reads web pages." },
  { type: "finish", finishReason: "stop" }
])

/**
 * Creates a model that answers each request with the next round's events.
 *
 * @param rounds - Events of each round, in request order.
 * @returns A stream opener recording its requests.
 */
function createRoundStreams(...rounds: (readonly ReplyStreamEvent[])[]) {
  const openReplyStream = vi.fn<OpenReplyStream>()
  for (const events of rounds)
    openReplyStream.mockImplementationOnce(async () =>
      (async function* () {
        yield* events
      })()
    )
  return openReplyStream
}

/**
 * Creates Armitage's live agent.
 *
 * @param openReplyStream - Model of the case.
 * @param replyContextMeter - Meter of the case; roomy by default.
 * @returns The agent.
 */
function createArmitage(
  openReplyStream: OpenReplyStream,
  replyContextMeter: ReplyContextMeter = createRoomyReplyContextMeter()
): Agent {
  return new Agent(ARMITAGE_PROFILE, {
    replyModel: { openReplyStream },
    replyContextMeter,
    stateReader: UNEXPECTED_STATE_READER,
    toolKeeper: UNEXPECTED_KEEPER
  })
}

/**
 * Builds a search for a web page reader.
 *
 * @param reportFailure - Receives why the search ended without finding.
 * @param abortSignal - Cancellation of the asking reply.
 * @returns The search over {@link TOOLS}.
 */
function buildSearch(
  reportFailure: (failure: unknown) => void,
  abortSignal: AbortSignal = new AbortController().signal
): ToolSearch {
  return {
    task: "read a web page",
    tools: TOOLS,
    conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
    model: "qwen/qwen3-8b",
    generationOptions: { temperature: 0.2 },
    abortSignal,
    reportFailure
  }
}

describe("runToolKeeperSearch", () => {
  it("finds the tools Armitage recommends with its own prompt, the task, and only its search tools", async () => {
    const openReplyStream = createRoundStreams(
      SEARCH_ROUND,
      RECOMMEND_ROUND,
      FINISH_ROUND
    )
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream),
      buildSearch(reportFailure)
    )

    expect(outcome).toEqual({ status: "found", toolNames: ["read_page"] })
    expect(reportFailure).not.toHaveBeenCalled()
    expect(openReplyStream).toHaveBeenCalledTimes(3)
    const [request] = openReplyStream.mock.calls[0] ?? []
    expect(request?.messages.slice(0, 2)).toEqual([
      { role: "system", content: ARMITAGE_PROMPT },
      expect.objectContaining({ role: "user", content: "read a web page" })
    ])
    expect(request?.tools.map((tool) => tool.function.name)).toEqual([
      SEARCH_TOOLS_TOOL_NAME,
      RECOMMEND_TOOL_TOOL_NAME
    ])
    expect(request).toMatchObject({
      model: "qwen/qwen3-8b",
      generationOptions: { temperature: 0.2 }
    })
    const [lastRequest] = openReplyStream.mock.calls[2] ?? []
    expect(lastRequest?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Recommended read_page: 1 of at most 5 tools."
    })
  })

  it("finds no tool when Armitage recommends none", async () => {
    const outcome = await runToolKeeperSearch(
      createArmitage(createRoundStreams(SEARCH_ROUND, FINISH_ROUND)),
      buildSearch(vi.fn())
    )

    expect(outcome).toEqual({ status: "found", toolNames: [] })
  })

  it("lists the search as Armitage's request on the asking conversation while it runs", async () => {
    let requests: readonly AgentRequestState[] = []
    const openReplyStream = vi.fn<OpenReplyStream>(async () =>
      (async function* () {
        requests = armitage.listRequests()
        yield* FINISH_ROUND
      })()
    )
    const armitage = createArmitage(openReplyStream)

    await runToolKeeperSearch(armitage, buildSearch(vi.fn()))

    expect(requests).toEqual([
      expect.objectContaining({
        conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
        model: "qwen/qwen3-8b"
      })
    ])
    expect(armitage.listRequests()).toEqual([])
  })

  it(`ends after ${MAXIMUM_TOOL_KEEPER_ROUND_COUNT} rounds of tool calls, keeping the recommendations so far`, async () => {
    const searchRounds = Array.from(
      { length: MAXIMUM_TOOL_KEEPER_ROUND_COUNT },
      () => SEARCH_ROUND
    )
    const openReplyStream = createRoundStreams(RECOMMEND_ROUND, ...searchRounds)
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream),
      buildSearch(reportFailure)
    )

    expect(outcome).toEqual({ status: "found", toolNames: ["read_page"] })
    expect(openReplyStream).toHaveBeenCalledTimes(
      MAXIMUM_TOOL_KEEPER_ROUND_COUNT + 1
    )
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it("fails and reports a model failure", async () => {
    const failure = new Error("model failed")
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(vi.fn<OpenReplyStream>().mockRejectedValue(failure)),
      buildSearch(reportFailure)
    )

    expect(outcome).toEqual({ status: "failed" })
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it("fails and reports a search the model reports as cancelled", async () => {
    const failure = new ChatCompletionCancelledError(new Error("cancelled"))
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(vi.fn<OpenReplyStream>().mockRejectedValue(failure)),
      buildSearch(reportFailure)
    )

    expect(outcome).toEqual({ status: "failed" })
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it("fails and reports a search whose model is not loaded, without reaching the model", async () => {
    const openReplyStream = vi.fn<OpenReplyStream>()
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream, createUnloadedReplyContextMeter()),
      buildSearch(reportFailure)
    )

    expect(outcome).toEqual({ status: "failed" })
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(openReplyStream).not.toHaveBeenCalled()
  })

  it("rejects with the abort reason when the asking reply stops during the search, reporting nothing", async () => {
    const stopReason = new Error("stopped")
    const abortController = new AbortController()
    const openReplyStream = vi.fn<OpenReplyStream>(async () =>
      (async function* () {
        abortController.abort(stopReason)
        yield* RECOMMEND_ROUND
      })()
    )
    const reportFailure = vi.fn()

    await expect(
      runToolKeeperSearch(
        createArmitage(openReplyStream),
        buildSearch(reportFailure, abortController.signal)
      )
    ).rejects.toBe(stopReason)
    expect(reportFailure).not.toHaveBeenCalled()
  })
})
