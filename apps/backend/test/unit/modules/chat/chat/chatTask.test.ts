import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import { describe, expect, it, vi } from "vitest"
import type { CompleteChatOptions } from "../../../../../src/di/services/chatService"
import type { AssistantMessageCompletion } from "../../../../../src/di/services/conversationService/share"
import createChatTask, {
  type CreateChatTaskOptions
} from "../../../../../src/modules/chat/chat/chatTask"
import type { ChatRouteReply } from "../../../../../src/modules/chat/chat/share"
import { ChatCompletionCancelledError } from "../../../../../src/utils/errors"
import {
  addChatSseRoute,
  createChatSseTestApp,
  requestChatSseRoute,
  type ChatSseTestAppOptions
} from "../../../support/chatSseRoute"
import { findLogRecords } from "../../../support/fastifyTestApp"
import { createChatCompletionChunk } from "../../../support/openAiEndpointFake"

/** Event sent to the client after a chat failure that was not a cancellation. */
const CHAT_FAILURE_EVENT = Object.freeze({
  event: "error",
  data: { type: "error", message: "Chat completion failed. Please try again." }
})

/** Log message written for every chat task failure. */
const CHAT_FAILURE_LOG = "Chat completion stream failed"

/** Inputs forwarded to the model by every case. */
const CHAT_INPUT = Object.freeze({
  messages: [{ role: "user" as const, content: "Hello" }],
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4, replyCeiling: 128 }
})

/** Test-controlled parts of one chat task run. */
type ChatTaskScenario = Readonly<{
  /** Model stream behavior. */
  completeChatStream: CreateChatTaskOptions["completeChatStream"]
  /** Cancellation owned by the case; a fresh signal by default. */
  abortSignal?: AbortSignal
  /** Delta persistence result; persists every delta by default. */
  updateAssistantMessageContent?: CreateChatTaskOptions["updateAssistantMessageContent"]
  /** Terminal persistence result; persists every transition by default. */
  updateAssistantMessageState?: CreateChatTaskOptions["updateAssistantMessageState"]
  /** Action run with the live reply just before the task starts. */
  prepareReply?: (reply: ChatRouteReply) => void
  /** Transport faults of the SSE connection. */
  transport?: ChatSseTestAppOptions
}>

/**
 * Creates a model stream that yields fixed chunks.
 *
 * @param chunks - Chunks yielded in order.
 * @returns A stream starter recording its inputs.
 */
function streamChunks(...chunks: ChatCompletionChunk[]) {
  return vi.fn<CreateChatTaskOptions["completeChatStream"]>(async () =>
    (async function* () {
      yield* chunks
    })()
  )
}

/**
 * Runs one chat task inside a live SSE request and records its effects.
 *
 * @param scenario - Model, persistence, cancellation, and transport behavior.
 * @returns The received events, persisted deltas and states, captured logs,
 * and the task's settlement.
 */
async function runChatTask(scenario: ChatTaskScenario) {
  const { app, logs } = await createChatSseTestApp(scenario.transport)
  const persistedDeltas: string[] = []
  const persistedStates: AssistantMessageCompletion[] = []
  const updateAssistantMessageContent = vi.fn(
    scenario.updateAssistantMessageContent ?? (() => true)
  )
  const updateAssistantMessageState = vi.fn(
    scenario.updateAssistantMessageState ?? (() => true)
  )
  let settlement:
    | Readonly<{ status: "resolved" }>
    | Readonly<{ status: "rejected"; error: unknown }>
    | undefined
  addChatSseRoute(app, async (request, reply) => {
    scenario.prepareReply?.(reply)
    settlement = await createChatTask({
      ...CHAT_INPUT,
      completeChatStream: scenario.completeChatStream,
      abortSignal: scenario.abortSignal ?? new AbortController().signal,
      request,
      reply,
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
    }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    )
  })
  const response = await requestChatSseRoute(app)
  return {
    events: response.events,
    persistedDeltas,
    persistedStates,
    updateAssistantMessageContent,
    logs,
    settlement
  }
}

describe("createChatTask", () => {
  it("forwards the conversation, model, generation options, and signal to the model", async () => {
    const abortSignal = new AbortController().signal
    const completeChatStream = streamChunks(
      createChatCompletionChunk({ finishReason: "stop" })
    )

    await runChatTask({ completeChatStream, abortSignal })

    expect(completeChatStream).toHaveBeenCalledWith({
      ...CHAT_INPUT,
      signal: abortSignal
    } satisfies CompleteChatOptions)
  })

  it("persists and publishes each delta, then completes with the finish reason", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Hi" }),
        createChatCompletionChunk({ content: " there" }),
        createChatCompletionChunk({ finishReason: "stop" })
      )
    })

    expect(run.persistedDeltas).toEqual(["Hi", " there"])
    expect(run.events).toEqual([
      { event: "delta", data: { type: "delta", content: "Hi" } },
      { event: "delta", data: { type: "delta", content: " there" } },
      { event: "done", data: { type: "done", finishReason: "stop" } }
    ])
    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" }
    ])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("completes with a length finish reason carried by the final delta", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Cut", finishReason: "length" })
      )
    })

    expect(run.persistedDeltas).toEqual(["Cut"])
    expect(run.events.map(({ event }) => event)).toEqual(["delta", "done"])
    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "length" }
    ])
  })

  it("ignores chunks without text or without the first choice", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        { ...createChatCompletionChunk({}), choices: [] },
        createChatCompletionChunk({ content: "other choice", index: 1 }),
        createChatCompletionChunk({ content: null }),
        createChatCompletionChunk({ content: "" }),
        createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
      )
    })

    expect(run.persistedDeltas).toEqual(["Hi"])
    expect(run.events.map(({ event }) => event)).toEqual(["delta", "done"])
  })

  it("stops without publishing a delta whose persistence was refused", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Hi" }),
        createChatCompletionChunk({ content: "deleted" }),
        createChatCompletionChunk({ content: "after" }),
        createChatCompletionChunk({ finishReason: "stop" })
      ),
      updateAssistantMessageContent: (content) => content !== "deleted"
    })

    expect(run.updateAssistantMessageContent.mock.calls).toEqual([
      ["Hi"],
      ["deleted"]
    ])
    expect(run.events).toEqual([
      { event: "delta", data: { type: "delta", content: "Hi" } }
    ])
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("sends no terminal event when the completed state was not persisted", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
      ),
      updateAssistantMessageState: () => false
    })

    expect(run.events.map(({ event }) => event)).toEqual(["delta"])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("persists completion without an event when the client has disconnected", async () => {
    let reply: ChatRouteReply | undefined
    const run = await runChatTask({
      prepareReply: (liveReply) => {
        reply = liveReply
      },
      completeChatStream: vi.fn(async () =>
        (async function* () {
          yield createChatCompletionChunk({ content: "Hi" })
          reply?.sse.close()
          yield createChatCompletionChunk({ finishReason: "stop" })
        })()
      )
    })

    expect(run.events.map(({ event }) => event)).toEqual(["delta"])
    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" }
    ])
  })

  it("keeps a persisted completion when the terminal event cannot be sent", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
      ),
      transport: { failingEventTypes: ["done"] }
    })

    expect(run.persistedStates).toEqual([
      { status: "completed", finishReason: "stop" }
    ])
    expect(run.settlement).toEqual({ status: "resolved" })
    expect(
      findLogRecords(run.logs, "Could not send the final chat event")
    ).toEqual([
      expect.objectContaining({
        level: "debug",
        err: expect.objectContaining({
          message: "Injected SSE serialization failure for done"
        })
      })
    ])
    expect(findLogRecords(run.logs, CHAT_FAILURE_LOG)).toEqual([])
  })

  it("interrupts without contacting the model when already cancelled", async () => {
    const completeChatStream = streamChunks()

    const run = await runChatTask({
      completeChatStream,
      abortSignal: AbortSignal.abort()
    })

    expect(completeChatStream).not.toHaveBeenCalled()
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([])
  })

  it("stops consuming the stream once cancelled and keeps the persisted text", async () => {
    const cancellation = new AbortController()
    const run = await runChatTask({
      abortSignal: cancellation.signal,
      completeChatStream: vi.fn(async () =>
        (async function* () {
          yield createChatCompletionChunk({ content: "Partial" })
          cancellation.abort()
          yield createChatCompletionChunk({ content: "ignored" })
          yield createChatCompletionChunk({ finishReason: "stop" })
        })()
      )
    })

    expect(run.persistedDeltas).toEqual(["Partial"])
    expect(run.events.map(({ event }) => event)).toEqual(["delta"])
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
  })

  it("interrupts when the stream ends after cancellation", async () => {
    const cancellation = new AbortController()
    const run = await runChatTask({
      abortSignal: cancellation.signal,
      completeChatStream: vi.fn(async () =>
        (async function* () {
          yield createChatCompletionChunk({ content: "Partial" })
          cancellation.abort()
        })()
      )
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events.map(({ event }) => event)).toEqual(["delta"])
  })

  it("interrupts without an error event when the model reports cancellation first", async () => {
    const run = await runChatTask({
      completeChatStream: vi.fn(async () => {
        throw new ChatCompletionCancelledError(new Error("aborted"))
      })
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("fails with an error event and log when the model request is rejected", async () => {
    const run = await runChatTask({
      completeChatStream: vi.fn(async () => {
        throw new Error("model not loaded")
      })
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
    expect(findLogRecords(run.logs, CHAT_FAILURE_LOG)).toEqual([
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({ message: "model not loaded" })
      })
    ])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("fails after the published text when the stream ends without a finish reason", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Partial" })
      )
    })

    expect(run.persistedDeltas).toEqual(["Partial"])
    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([
      { event: "delta", data: { type: "delta", content: "Partial" } },
      CHAT_FAILURE_EVENT
    ])
    expect(findLogRecords(run.logs, CHAT_FAILURE_LOG)).toEqual([
      expect.objectContaining({
        err: expect.objectContaining({
          message: "Model stream ended without a finish reason"
        })
      })
    ])
  })

  it("fails on an unsupported finish reason", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ finishReason: "tool_calls" })
      )
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
  })

  it("fails when a delta cannot be persisted", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Hi" })
      ),
      updateAssistantMessageContent: () => {
        throw new Error("Conversation store is closed")
      }
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
  })

  it("fails without an error event when the client has disconnected", async () => {
    let reply: ChatRouteReply | undefined
    const run = await runChatTask({
      prepareReply: (liveReply) => {
        reply = liveReply
      },
      completeChatStream: vi.fn(async () =>
        (async function* () {
          yield createChatCompletionChunk({ content: "Hi" })
          reply?.sse.close()
          throw new Error("socket hang up")
        })()
      )
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events.map(({ event }) => event)).toEqual(["delta"])
  })

  it("rejects with both failures when the failed state cannot be persisted", async () => {
    const streamFailure = new Error("model not loaded")
    const persistenceFailure = new Error("Conversation store is closed")
    const run = await runChatTask({
      completeChatStream: vi.fn(async () => {
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
      error: {
        message: "Chat failure could not be finalized",
        errors: [streamFailure, persistenceFailure],
        cause: persistenceFailure
      }
    })
    expect(run.events).toEqual([])
  })
})
