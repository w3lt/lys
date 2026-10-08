import type { ChatGenerationEvent } from "@lys/protocol"
import type { ConversationMessage } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import Agent, {
  type AgentTurn,
  type AssistantMessageCompletion
} from "../../../../src/modules/agent/agent"
import type {
  ReplyModel,
  ReplyStreamEvent
} from "../../../../src/modules/agent/replyModel"
import { ChatCompletionCancelledError } from "../../../../src/utils/errors"
import {
  createAssistantMessage,
  createUserMessage
} from "../../support/conversationFixtures"

/** Opens one reply stream for the agent under test. */
type OpenReplyStream = ReplyModel["openReplyStream"]

/**
 * Matches the event sent to followers after a failure that was not a
 * cancellation; its user-presentable message is any non-blank text.
 */
const CHAT_FAILURE_EVENT = Object.freeze({
  type: "error",
  message: expect.stringMatching(/\S/)
})

/** Event sent to followers when the reply ended before it completed. */
const INTERRUPTED_EVENT = Object.freeze({ type: "interrupted" })

/** Profile of the agent under test. */
const AGENT_PROFILE = Object.freeze({
  code: "lys",
  systemPrompt: "You are Lys."
})

/** Request values every case's turn carries. */
const TURN_REQUEST = Object.freeze({
  userMessageContent: "Hello",
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4, replyCeiling: 128 }
})

/** Test-controlled parts of one reply. */
type AgentReplyScenario = Readonly<{
  /** Model behavior. */
  openReplyStream: OpenReplyStream
  /** Transcript before the turn; empty by default. */
  history?: readonly ConversationMessage[]
  /** Cancellation owned by the case; a fresh signal by default. */
  abortSignal?: AbortSignal
  /** Delta storage result; stores every delta by default. */
  updateAssistantMessageContent?: AgentTurn["updateAssistantMessageContent"]
  /** Final-state storage result; stores every transition by default. */
  updateAssistantMessageState?: AgentTurn["updateAssistantMessageState"]
}>

/**
 * Creates a model whose stream yields fixed events.
 *
 * @param events - Events yielded in order.
 * @returns A stream opener recording its requests.
 */
function createEventStream(...events: ReplyStreamEvent[]) {
  return vi.fn<OpenReplyStream>(async () =>
    (async function* () {
      yield* events
    })()
  )
}

/**
 * Has one agent answer one turn to settlement and records the effects.
 *
 * @param scenario - Model, history, storage, and cancellation behavior.
 * @returns The sent events, stored deltas and states, reported cancellations
 * and failures, and the reply's settlement.
 */
async function getAgentReplyOutcome(scenario: AgentReplyScenario) {
  const events: ChatGenerationEvent[] = []
  const reportedCancellations: unknown[] = []
  const reportedFailures: unknown[] = []
  const persistedDeltas: string[] = []
  const persistedStates: AssistantMessageCompletion[] = []
  const updateAssistantMessageContent = vi.fn(
    scenario.updateAssistantMessageContent ?? (() => true)
  )
  const updateAssistantMessageState = vi.fn(
    scenario.updateAssistantMessageState ?? (() => true)
  )
  const agent = new Agent(AGENT_PROFILE, {
    openReplyStream: scenario.openReplyStream
  })
  const settlement = await agent
    .createReply({
      ...TURN_REQUEST,
      history: scenario.history ?? [],
      abortSignal: scenario.abortSignal ?? new AbortController().signal,
      sendEvent: (event) => {
        events.push(event)
      },
      reportReplyCancellation: (failure) => {
        reportedCancellations.push(failure)
      },
      reportReplyFailure: (failure) => {
        reportedFailures.push(failure)
      },
      updateAssistantMessageContent: (content) => {
        const persisted = updateAssistantMessageContent(content)
        if (persisted) {
          persistedDeltas.push(content)
        }
        return persisted
      },
      updateAssistantMessageState: (completion) => {
        persistedStates.push(completion)
        return updateAssistantMessageState(completion)
      }
    })
    .then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    )
  return {
    events,
    persistedDeltas,
    persistedStates,
    updateAssistantMessageContent,
    reportedCancellations,
    reportedFailures,
    settlement
  }
}

describe("Agent", () => {
  it("reports the code it was created with", () => {
    const agent = new Agent(AGENT_PROFILE, {
      openReplyStream: createEventStream()
    })

    expect(agent.code).toBe("lys")
  })

  it("sends its own system prompt, the usable history, and the new message with the turn's model, options, and signal", async () => {
    const abortSignal = new AbortController().signal
    const openReplyStream = createEventStream({
      type: "finish",
      finishReason: "stop"
    })

    await getAgentReplyOutcome({
      openReplyStream,
      abortSignal,
      history: [
        createUserMessage(1, "Earlier question"),
        createAssistantMessage(2, "Earlier answer", {
          status: "completed",
          finishReason: "stop"
        }),
        createAssistantMessage(3, "Failed answer", { status: "failed" })
      ]
    })

    expect(openReplyStream).toHaveBeenCalledWith({
      messages: [
        { role: "system", content: "You are Lys." },
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Hello" }
      ],
      model: TURN_REQUEST.model,
      generationOptions: TURN_REQUEST.generationOptions,
      abortSignal
    })
  })

  it("stores and sends each text, then completes with the finish reason", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "text", content: "Hi" },
        { type: "text", content: " there" },
        { type: "finish", finishReason: "stop" }
      )
    })

    expect(run.persistedDeltas).toEqual(["Hi", " there"])
    expect(run.events).toEqual([
      { type: "delta", content: "Hi" },
      { type: "delta", content: " there" },
      { type: "done", finishReason: "stop" }
    ])
    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" }
    ])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("completes with a length finish reason", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "text", content: "Cut" },
        { type: "finish", finishReason: "length" }
      )
    })

    expect(run.events).toEqual([
      { type: "delta", content: "Cut" },
      { type: "done", finishReason: "length" }
    ])
    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "length" }
    ])
  })

  it("interrupts without sending text whose storage was refused and releases the stream", async () => {
    let isStreamReleased = false
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          try {
            yield { type: "text", content: "Hi" }
            yield { type: "text", content: "deleted" }
            yield { type: "text", content: "after" }
            yield { type: "finish", finishReason: "stop" }
          } finally {
            isStreamReleased = true
          }
        })()
      ),
      updateAssistantMessageContent: (content) => content !== "deleted"
    })

    expect(run.updateAssistantMessageContent.mock.calls).toEqual([
      ["Hi"],
      ["deleted"]
    ])
    expect(run.events).toEqual([
      { type: "delta", content: "Hi" },
      INTERRUPTED_EVENT
    ])
    expect(
      run.persistedStates.filter(({ status }) => status !== "interrupted")
    ).toEqual([])
    expect(isStreamReleased).toBe(true)
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("reports an interruption when a newer turn or a deletion already finalized the reply", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "text", content: "Hi" },
        { type: "finish", finishReason: "stop" }
      ),
      updateAssistantMessageState: () => false
    })

    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" }
    ])
    expect(run.events).toEqual([
      { type: "delta", content: "Hi" },
      INTERRUPTED_EVENT
    ])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("interrupts without contacting the model when already cancelled", async () => {
    const openReplyStream = createEventStream()

    const run = await getAgentReplyOutcome({
      openReplyStream,
      abortSignal: AbortSignal.abort()
    })

    expect(openReplyStream).not.toHaveBeenCalled()
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([INTERRUPTED_EVENT])
  })

  it("stops reading the stream once cancelled, keeps the stored text, and releases the stream", async () => {
    const cancellation = new AbortController()
    let isStreamReleased = false
    const run = await getAgentReplyOutcome({
      abortSignal: cancellation.signal,
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          try {
            yield { type: "text", content: "Partial" }
            cancellation.abort()
            yield { type: "text", content: "ignored" }
            yield { type: "finish", finishReason: "stop" }
          } finally {
            isStreamReleased = true
          }
        })()
      )
    })

    expect(run.persistedDeltas).toEqual(["Partial"])
    expect(run.events).toEqual([
      { type: "delta", content: "Partial" },
      INTERRUPTED_EVENT
    ])
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(isStreamReleased).toBe(true)
  })

  it("interrupts when the stream ends after cancellation", async () => {
    const cancellation = new AbortController()
    const run = await getAgentReplyOutcome({
      abortSignal: cancellation.signal,
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          yield { type: "text", content: "Partial" }
          cancellation.abort()
        })()
      )
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([
      { type: "delta", content: "Partial" },
      INTERRUPTED_EVENT
    ])
  })

  it("interrupts and reports a cancellation when the model reports cancellation before the agent observes its abort", async () => {
    const cancellation = new ChatCompletionCancelledError(new Error("aborted"))
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () => {
        throw cancellation
      })
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([INTERRUPTED_EVENT])
    expect(run.reportedCancellations).toEqual([cancellation])
    expect(run.reportedFailures).toEqual([])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("interrupts when the model request fails after the turn was stopped", async () => {
    const cancellation = new AbortController()
    const run = await getAgentReplyOutcome({
      abortSignal: cancellation.signal,
      openReplyStream: vi.fn<OpenReplyStream>(async () => {
        cancellation.abort()
        throw new Error("socket hang up")
      })
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([INTERRUPTED_EVENT])
    expect(run.reportedCancellations).toEqual([
      expect.objectContaining({ message: "socket hang up" })
    ])
    expect(run.reportedFailures).toEqual([])
  })

  it("interrupts when the stream fails after its own abort", async () => {
    const cancellation = new AbortController()
    const run = await getAgentReplyOutcome({
      abortSignal: cancellation.signal,
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          yield { type: "text", content: "Partial" }
          cancellation.abort()
          throw new Error("socket hang up")
        })()
      )
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([
      { type: "delta", content: "Partial" },
      INTERRUPTED_EVENT
    ])
    expect(run.reportedCancellations).toEqual([
      expect.objectContaining({ message: "socket hang up" })
    ])
    expect(run.reportedFailures).toEqual([])
  })

  it("fails with an error event and reports the failure when the model request is rejected", async () => {
    const rejection = new Error("model not loaded")
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () => {
        throw rejection
      })
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
    expect(run.reportedFailures).toEqual([rejection])
    expect(run.reportedCancellations).toEqual([])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("fails after the sent text when the stream fails", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () =>
        (async function* (): AsyncGenerator<ReplyStreamEvent> {
          yield { type: "text", content: "Partial" }
          throw new Error("Unsupported chat finish reason")
        })()
      )
    })

    expect(run.persistedDeltas).toEqual(["Partial"])
    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([
      { type: "delta", content: "Partial" },
      CHAT_FAILURE_EVENT
    ])
  })

  it("fails after the sent text when the stream ends without a finish reason", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream({ type: "text", content: "Partial" })
    })

    expect(run.persistedDeltas).toEqual(["Partial"])
    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([
      { type: "delta", content: "Partial" },
      CHAT_FAILURE_EVENT
    ])
    expect(run.reportedFailures).toEqual([
      new Error("Model stream ended without a finish reason")
    ])
  })

  it("fails without sending text that cannot be stored", async () => {
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream({ type: "text", content: "Hi" }),
      updateAssistantMessageContent: () => {
        throw new Error("Database is closed")
      }
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
  })

  it("fails after the sent text when the completed state cannot be stored", async () => {
    const persistenceFailure = new Error("Database is closed")
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream(
        { type: "text", content: "Hi" },
        { type: "finish", finishReason: "stop" }
      ),
      updateAssistantMessageState: vi
        .fn<AgentTurn["updateAssistantMessageState"]>()
        .mockImplementationOnce(() => {
          throw persistenceFailure
        })
        .mockReturnValue(true)
    })

    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" },
      { status: "failed" }
    ])
    expect(run.events).toEqual([
      { type: "delta", content: "Hi" },
      CHAT_FAILURE_EVENT
    ])
    expect(run.reportedFailures).toEqual([persistenceFailure])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("fails when the interrupted state cannot be stored", async () => {
    const persistenceFailure = new Error("Database is closed")
    const run = await getAgentReplyOutcome({
      openReplyStream: createEventStream({ type: "text", content: "deleted" }),
      updateAssistantMessageContent: () => false,
      updateAssistantMessageState: vi
        .fn<AgentTurn["updateAssistantMessageState"]>()
        .mockImplementationOnce(() => {
          throw persistenceFailure
        })
        .mockReturnValue(true)
    })

    expect(run.persistedStates).toEqual([
      { status: "interrupted" },
      { status: "failed" }
    ])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("rejects with both failures and sends no event when the failed state cannot be stored", async () => {
    const streamFailure = new Error("model not loaded")
    const persistenceFailure = new Error("Database is closed")
    const run = await getAgentReplyOutcome({
      openReplyStream: vi.fn<OpenReplyStream>(async () => {
        throw streamFailure
      }),
      updateAssistantMessageState: () => {
        throw persistenceFailure
      }
    })

    expect(run.settlement).toEqual({
      status: "rejected",
      error: expect.any(AggregateError)
    })
    expect(run.settlement).toMatchObject({
      error: { errors: [streamFailure, persistenceFailure] }
    })
    expect(run.events).toEqual([])
  })

  it("answers overlapping turns independently", async () => {
    const firstReplyGate = Promise.withResolvers<void>()
    const agent = new Agent(AGENT_PROFILE, {
      openReplyStream: async (request) => {
        const question = request.messages.at(-1)?.content ?? ""
        return (async function* (): AsyncGenerator<ReplyStreamEvent> {
          if (question === "First") await firstReplyGate.promise
          yield { type: "text", content: `Re: ${question}` }
          yield { type: "finish", finishReason: "stop" }
        })()
      }
    })
    const firstEvents: ChatGenerationEvent[] = []
    const secondEvents: ChatGenerationEvent[] = []
    /**
     * Builds a turn that stores everything and records its events.
     *
     * @param userMessageContent - Question the turn answers.
     * @param events - Receives the turn's events in order.
     * @returns The turn.
     */
    const createTurn = (
      userMessageContent: string,
      events: ChatGenerationEvent[]
    ): AgentTurn => ({
      ...TURN_REQUEST,
      history: [],
      userMessageContent,
      abortSignal: new AbortController().signal,
      updateAssistantMessageContent: () => true,
      updateAssistantMessageState: () => true,
      sendEvent: (event) => {
        events.push(event)
      },
      reportReplyCancellation: () => undefined,
      reportReplyFailure: () => undefined
    })

    const firstReply = agent.createReply(createTurn("First", firstEvents))
    await agent.createReply(createTurn("Second", secondEvents))
    expect(firstEvents).toEqual([])
    firstReplyGate.resolve()
    await firstReply

    expect(firstEvents).toEqual([
      { type: "delta", content: "Re: First" },
      { type: "done", finishReason: "stop" }
    ])
    expect(secondEvents).toEqual([
      { type: "delta", content: "Re: Second" },
      { type: "done", finishReason: "stop" }
    ])
  })
})
