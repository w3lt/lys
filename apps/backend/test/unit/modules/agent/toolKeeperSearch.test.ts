import type { MessageGenerationOptions } from "@lys/protocol"
import { ARMITAGE_AGENT_CODE } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import Agent, { type AgentProfile } from "../../../../src/modules/agent/agent"
import {
  AgentRequestLimitError,
  type AgentRequestState
} from "../../../../src/modules/agent/agentActivity"
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
import {
  formatToolCallDenial,
  type ToolCallPolicy
} from "../../../../src/modules/toolApproval/toolCallPolicy"
import { ChatCompletionCancelledError } from "../../../../src/utils/errors"
import { LM_STUDIO_QWEN3_8B } from "../../support/llmFixtures"
import {
  createRoomyReplyContextMeter,
  createUnloadedReplyContextMeter
} from "../../support/replyContextMeterFakes"
import {
  buildNetworkToolDefinition,
  createToolSearchCallRecords,
  SEARCH_CALL_ID,
  TOOL_CALL_POLICY
} from "../../support/toolFixtures"

/** Opens one round's stream. */
type OpenReplyStream = ReplyModel["openReplyStream"]

/** System prompt of Armitage in every case. */
const ARMITAGE_PROMPT = "You are Armitage, the tool keeper."

/** Request limits of Armitage in every case. */
const REQUEST_LIMITS = Object.freeze({ slotCount: 2, waitingLimit: 2 })

/**
 * Fails a read the case did not arrange.
 *
 * @throws Always.
 */
function handleUnexpectedRead(): never {
  throw new Error("Unexpected read")
}

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

/** Round that recommends the page reader, the first tool of a search. */
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
 * @returns The agent, whose state reader and keeper fail the case when
 * used: Armitage has no state tools, and its own turns are never routed.
 */
function createArmitage(
  openReplyStream: OpenReplyStream,
  replyContextMeter: ReplyContextMeter = createRoomyReplyContextMeter()
): Agent {
  const profile: AgentProfile = {
    code: ARMITAGE_AGENT_CODE,
    role: "tool-keeper",
    systemPrompt: ARMITAGE_PROMPT,
    requestLimits: REQUEST_LIMITS
  }
  const replyModel: ReplyModel = { openReplyStream }
  const stateReader: AgentStateReader = {
    listAgentMatches: handleUnexpectedRead,
    findAgentState: handleUnexpectedRead
  }
  const toolKeeper: ToolKeeper = { findTools: handleUnexpectedRead }
  return new Agent(profile, {
    replyModel,
    replyContextMeter,
    stateReader,
    toolKeeper
  })
}

/**
 * Builds a search for a web page reader.
 *
 * @param reportFailure - Receives why the search ended without finding.
 * @param abortSignal - Cancellation of the asking reply.
 * @param toolCallPolicy - Policy of the asking turn.
 * @returns The search over the asking turn's tools: `read_page`, then
 * `send_email`.
 */
function buildSearch(
  reportFailure: (failure: unknown) => void,
  abortSignal: AbortSignal = new AbortController().signal,
  toolCallPolicy: ToolCallPolicy = TOOL_CALL_POLICY
): ToolSearch {
  const tools = [
    buildNetworkToolDefinition(
      "read_page",
      "Reads one web page and returns its text."
    ),
    buildNetworkToolDefinition("send_email", "Sends an email message.")
  ]
  const generationOptions: MessageGenerationOptions = { temperature: 0.2 }
  return {
    task: "read a web page",
    searchCallId: SEARCH_CALL_ID,
    tools,
    conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
    model: LM_STUDIO_QWEN3_8B,
    generationOptions,
    abortSignal,
    reportFailure,
    toolCallPolicy
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
    const search = buildSearch(reportFailure)

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream),
      search,
      createToolSearchCallRecords().records
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
      model: LM_STUDIO_QWEN3_8B,
      generationOptions: search.generationOptions
    })
    const [lastRequest] = openReplyStream.mock.calls[2] ?? []
    expect(lastRequest?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Recommended read_page: 1 of at most 5 tools."
    })
  })

  it("finds every tool of the asking turn Armitage recommends, in the order recommended", async () => {
    const openReplyStream = createRoundStreams(
      buildToolCallRound(RECOMMEND_TOOL_TOOL_NAME, { name: "send_email" }),
      RECOMMEND_ROUND,
      FINISH_ROUND
    )

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream),
      buildSearch(vi.fn()),
      createToolSearchCallRecords().records
    )

    expect(outcome).toEqual({
      status: "found",
      toolNames: ["send_email", "read_page"]
    })
  })

  it("decides each of Armitage's calls by the search's tool call policy, without asking anyone", async () => {
    const settingsFilePath = "/srv/lys/settings.json"
    const toolCallPolicy: ToolCallPolicy = Object.freeze({
      ...TOOL_CALL_POLICY,
      settingsFilePath
    })
    const openReplyStream = createRoundStreams(
      buildToolCallRound(SEARCH_TOOLS_TOOL_NAME, { query: settingsFilePath }),
      FINISH_ROUND
    )

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream),
      buildSearch(vi.fn(), new AbortController().signal, toolCallPolicy),
      createToolSearchCallRecords().records
    )

    expect(outcome).toEqual({ status: "found", toolNames: [] })
    const [lastRequest] = openReplyStream.mock.calls[1] ?? []
    expect(lastRequest?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: formatToolCallDenial("credential-file")
    })
  })

  it("records each of Armitage's calls under the search's find_tools call, with how the policy decided it and how it ended", async () => {
    const settingsFilePath = "/srv/lys/settings.json"
    const toolCallPolicy: ToolCallPolicy = Object.freeze({
      ...TOOL_CALL_POLICY,
      settingsFilePath
    })
    const recorded = createToolSearchCallRecords()
    const deniedArgumentText = JSON.stringify({ query: settingsFilePath })
    const openReplyStream = createRoundStreams(
      SEARCH_ROUND,
      buildToolCallRound(SEARCH_TOOLS_TOOL_NAME, { query: settingsFilePath }),
      RECOMMEND_ROUND,
      FINISH_ROUND
    )

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream),
      buildSearch(vi.fn(), new AbortController().signal, toolCallPolicy),
      recorded.records
    )

    expect(outcome).toEqual({ status: "found", toolNames: ["read_page"] })
    const allowed = { policyDecision: { effect: "allow" } }
    expect(recorded.created).toEqual([
      {
        searchCallId: SEARCH_CALL_ID,
        agentCode: ARMITAGE_AGENT_CODE,
        call: expect.objectContaining({
          toolName: SEARCH_TOOLS_TOOL_NAME,
          argumentText: '{"query":"web page"}',
          status: "running"
        }),
        decision: allowed
      },
      {
        searchCallId: SEARCH_CALL_ID,
        agentCode: ARMITAGE_AGENT_CODE,
        call: expect.objectContaining({
          argumentText: deniedArgumentText,
          status: "failed"
        }),
        decision: {
          policyDecision: { effect: "deny", reason: "credential-file" }
        }
      },
      {
        searchCallId: SEARCH_CALL_ID,
        agentCode: ARMITAGE_AGENT_CODE,
        call: expect.objectContaining({
          toolName: RECOMMEND_TOOL_TOOL_NAME,
          status: "running"
        }),
        decision: allowed
      }
    ])
    expect(recorded.ended.map((call) => [call.id, call.status])).toEqual([
      [recorded.created[0]?.call.id, "succeeded"],
      [recorded.created[2]?.call.id, "succeeded"]
    ])
  })

  it("runs no call of Armitage's it could not record because the search's find_tools call no longer runs", async () => {
    const recorded = createToolSearchCallRecords(false)
    const openReplyStream = createRoundStreams(RECOMMEND_ROUND, FINISH_ROUND)
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream),
      buildSearch(reportFailure),
      recorded.records
    )

    expect(outcome).toEqual({ status: "found", toolNames: [] })
    expect(recorded.created).toHaveLength(1)
    expect(recorded.ended).toEqual([])
    expect(openReplyStream).toHaveBeenCalledOnce()
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it("fails and reports a search whose call cannot be recorded, running none of its calls", async () => {
    const failure = new Error("Database is closed")
    const records = {
      createToolSearchCallRecord: vi.fn((): boolean => {
        throw failure
      }),
      updateToolSearchCallOutcome: vi.fn(() => true)
    }
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(createRoundStreams(RECOMMEND_ROUND, FINISH_ROUND)),
      buildSearch(reportFailure),
      records
    )

    expect(outcome).toEqual({ status: "failed" })
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure)
    expect(records.updateToolSearchCallOutcome).not.toHaveBeenCalled()
  })

  it("finds no tool when Armitage recommends none", async () => {
    const outcome = await runToolKeeperSearch(
      createArmitage(createRoundStreams(SEARCH_ROUND, FINISH_ROUND)),
      buildSearch(vi.fn()),
      createToolSearchCallRecords().records
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

    await runToolKeeperSearch(
      armitage,
      buildSearch(vi.fn()),
      createToolSearchCallRecords().records
    )

    expect(requests).toEqual([
      expect.objectContaining({
        conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
        model: LM_STUDIO_QWEN3_8B
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
      buildSearch(reportFailure),
      createToolSearchCallRecords().records
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
      buildSearch(reportFailure),
      createToolSearchCallRecords().records
    )

    expect(outcome).toEqual({ status: "failed" })
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it("fails and reports a search the model reports as cancelled", async () => {
    const failure = new ChatCompletionCancelledError(new Error("cancelled"))
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(vi.fn<OpenReplyStream>().mockRejectedValue(failure)),
      buildSearch(reportFailure),
      createToolSearchCallRecords().records
    )

    expect(outcome).toEqual({ status: "failed" })
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it("fails and reports a search whose model is not loaded, without reaching the model", async () => {
    const openReplyStream = vi.fn<OpenReplyStream>()
    const reportFailure = vi.fn()

    const outcome = await runToolKeeperSearch(
      createArmitage(openReplyStream, createUnloadedReplyContextMeter()),
      buildSearch(reportFailure),
      createToolSearchCallRecords().records
    )

    expect(outcome).toEqual({ status: "failed" })
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(openReplyStream).not.toHaveBeenCalled()
  })

  it("fails and reports a search refused because Armitage's request slots and line are full, without reaching the model", async () => {
    const release = Promise.withResolvers<void>()
    const openReplyStream = vi.fn<OpenReplyStream>(async () =>
      (async function* () {
        await release.promise
        yield* FINISH_ROUND
      })()
    )
    const armitage = createArmitage(openReplyStream)
    const heldCount = REQUEST_LIMITS.slotCount + REQUEST_LIMITS.waitingLimit
    const held = Array.from({ length: heldCount }, () =>
      runToolKeeperSearch(
        armitage,
        buildSearch(vi.fn()),
        createToolSearchCallRecords().records
      )
    )
    const reportFailure = vi.fn()

    try {
      await vi.waitFor(() => {
        expect(armitage.listRequests()).toHaveLength(heldCount)
        expect(openReplyStream).toHaveBeenCalledTimes(REQUEST_LIMITS.slotCount)
      })

      const outcome = await runToolKeeperSearch(
        armitage,
        buildSearch(reportFailure),
        createToolSearchCallRecords().records
      )

      expect(outcome).toEqual({ status: "failed" })
      expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
        expect.any(AgentRequestLimitError)
      )
      expect(reportFailure.mock.calls[0]?.[0]).toHaveProperty(
        "limits",
        REQUEST_LIMITS
      )
      expect(openReplyStream).toHaveBeenCalledTimes(REQUEST_LIMITS.slotCount)
    } finally {
      release.resolve()
      await Promise.all(held)
    }
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
        buildSearch(reportFailure, abortController.signal),
        createToolSearchCallRecords().records
      )
    ).rejects.toBe(stopReason)
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it("stops Armitage's reply with the asking reply: its round gets the asking reply's signal, and no round follows the stop", async () => {
    const abortController = new AbortController()
    const openReplyStream = vi.fn<OpenReplyStream>(async () =>
      (async function* () {
        abortController.abort(new Error("stopped"))
        yield* RECOMMEND_ROUND
      })()
    )

    await expect(
      runToolKeeperSearch(
        createArmitage(openReplyStream),
        buildSearch(vi.fn(), abortController.signal),
        createToolSearchCallRecords().records
      )
    ).rejects.toThrow("stopped")

    expect(openReplyStream).toHaveBeenCalledOnce()
    expect(openReplyStream.mock.calls[0]?.[0].abortSignal).toBe(
      abortController.signal
    )
  })

  it("reports nothing when the model reports a cancellation after the asking reply stopped", async () => {
    const stopReason = new Error("stopped")
    const abortController = new AbortController()
    const openReplyStream = vi.fn<OpenReplyStream>(async () => {
      abortController.abort(stopReason)
      throw new ChatCompletionCancelledError(new Error("cancelled"))
    })
    const reportFailure = vi.fn()

    await expect(
      runToolKeeperSearch(
        createArmitage(openReplyStream),
        buildSearch(reportFailure, abortController.signal),
        createToolSearchCallRecords().records
      )
    ).rejects.toBe(stopReason)
    expect(reportFailure).not.toHaveBeenCalled()
  })
})
