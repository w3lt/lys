import type { ChatGenerationEvent } from "@lys/protocol"
import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import { describe, expect, it, vi } from "vitest"
import type { CompleteChatOptions } from "../../../../../src/di/services/chatService"
import type { AssistantMessageCompletion } from "../../../../../src/di/services/conversationService/share"
import createChatTask, {
  type CreateChatTaskOptions
} from "../../../../../src/modules/chat/chat/chatTask"
import { ChatCompletionCancelledError } from "../../../../../src/utils/errors"
import { createTestFastify } from "../../../support/fastifyTestApp"
import { createChatCompletionChunk } from "../../../support/openAiEndpointFake"

/**
 * Matches the event sent to followers after a chat failure that was not a
 * cancellation; its user-presentable message is any non-blank text.
 */
const CHAT_FAILURE_EVENT = Object.freeze({
  type: "error",
  message: expect.stringMatching(/\S/)
})

/** Event sent to followers when the reply ended before it completed. */
const INTERRUPTED_EVENT = Object.freeze({ type: "interrupted" })

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
  /** Delta storage result; stores every delta by default. */
  updateAssistantMessageContent?: CreateChatTaskOptions["updateAssistantMessageContent"]
  /** Final-state storage result; stores every transition by default. */
  updateAssistantMessageState?: CreateChatTaskOptions["updateAssistantMessageState"]
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
 * Runs one chat task to settlement and records its effects.
 *
 * @param scenario - Model, storage, and cancellation behavior.
 * @returns The sent events, stored deltas and states, captured logs, and the
 * task's settlement.
 */
async function runChatTask(scenario: ChatTaskScenario) {
  const { app, logs } = createTestFastify()
  const events: ChatGenerationEvent[] = []
  const persistedDeltas: string[] = []
  const persistedStates: AssistantMessageCompletion[] = []
  const updateAssistantMessageContent = vi.fn(
    scenario.updateAssistantMessageContent ?? (() => true)
  )
  const updateAssistantMessageState = vi.fn(
    scenario.updateAssistantMessageState ?? (() => true)
  )
  const settlement = await createChatTask({
    ...CHAT_INPUT,
    completeChatStream: scenario.completeChatStream,
    abortSignal: scenario.abortSignal ?? new AbortController().signal,
    sendEvent: (event) => {
      events.push(event)
    },
    logger: app.log,
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
  return {
    events,
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

  it("stores and sends each delta, then completes with the finish reason", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Hi" }),
        createChatCompletionChunk({ content: " there" }),
        createChatCompletionChunk({ finishReason: "stop" })
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

  it("completes with a length finish reason carried by the final delta", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Cut", finishReason: "length" })
      )
    })

    expect(run.persistedDeltas).toEqual(["Cut"])
    expect(run.events).toEqual([
      { type: "delta", content: "Cut" },
      { type: "done", finishReason: "length" }
    ])
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
    expect(run.events.map(({ type }) => type)).toEqual(["delta", "done"])
  })

  it("interrupts without sending a delta whose storage was refused", async () => {
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
      { type: "delta", content: "Hi" },
      INTERRUPTED_EVENT
    ])
    expect(
      run.persistedStates.filter(({ status }) => status !== "interrupted")
    ).toEqual([])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("reports an interruption when a newer turn or a deletion already finalized the reply", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
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
    const completeChatStream = streamChunks()

    const run = await runChatTask({
      completeChatStream,
      abortSignal: AbortSignal.abort()
    })

    expect(completeChatStream).not.toHaveBeenCalled()
    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([INTERRUPTED_EVENT])
  })

  it("stops consuming the stream once cancelled and keeps the stored text", async () => {
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
    expect(run.events).toEqual([
      { type: "delta", content: "Partial" },
      INTERRUPTED_EVENT
    ])
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
    expect(run.events).toEqual([
      { type: "delta", content: "Partial" },
      INTERRUPTED_EVENT
    ])
  })

  it("interrupts with a debug log when the model reports cancellation before the task observes its abort", async () => {
    const run = await runChatTask({
      completeChatStream: vi.fn(async () => {
        throw new ChatCompletionCancelledError(new Error("aborted"))
      })
    })

    expect(run.persistedStates).toEqual([{ status: "interrupted" }])
    expect(run.events).toEqual([INTERRUPTED_EVENT])
    expect(run.logs.filter(({ level }) => level === "debug")).toEqual([
      expect.objectContaining({
        err: expect.objectContaining({ type: "ChatCompletionCancelledError" })
      })
    ])
    expect(run.logs.filter(({ level }) => level === "error")).toEqual([])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("interrupts when the stream fails after its own abort", async () => {
    const cancellation = new AbortController()
    const run = await runChatTask({
      abortSignal: cancellation.signal,
      completeChatStream: vi.fn(async () =>
        (async function* () {
          yield createChatCompletionChunk({ content: "Partial" })
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
    expect(run.logs.filter(({ level }) => level === "debug")).toEqual([
      expect.objectContaining({
        err: expect.objectContaining({ message: "socket hang up" })
      })
    ])
    expect(run.logs.filter(({ level }) => level === "error")).toEqual([])
  })

  it("fails with an error event and log when the model request is rejected", async () => {
    const run = await runChatTask({
      completeChatStream: vi.fn(async () => {
        throw new Error("model not loaded")
      })
    })

    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([CHAT_FAILURE_EVENT])
    expect(run.logs.filter(({ level }) => level === "error")).toEqual([
      expect.objectContaining({
        err: expect.objectContaining({ message: "model not loaded" })
      })
    ])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("fails after the sent text when the stream ends without a finish reason", async () => {
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Partial" })
      )
    })

    expect(run.persistedDeltas).toEqual(["Partial"])
    expect(run.persistedStates).toEqual([{ status: "failed" }])
    expect(run.events).toEqual([
      { type: "delta", content: "Partial" },
      CHAT_FAILURE_EVENT
    ])
    expect(run.logs.filter(({ level }) => level === "error")).toEqual([
      expect.objectContaining({ err: expect.any(Object) })
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

  it("fails without sending the delta when it cannot be stored", async () => {
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

  it("fails after the sent text when the completed state cannot be stored", async () => {
    const persistenceFailure = new Error("Conversation store is closed")
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
      ),
      updateAssistantMessageState: vi
        .fn<CreateChatTaskOptions["updateAssistantMessageState"]>()
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
    expect(run.logs.filter(({ level }) => level === "error")).toEqual([
      expect.objectContaining({
        err: expect.objectContaining({ message: persistenceFailure.message })
      })
    ])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("fails when the interrupted state cannot be stored", async () => {
    const persistenceFailure = new Error("Conversation store is closed")
    const run = await runChatTask({
      completeChatStream: streamChunks(
        createChatCompletionChunk({ content: "deleted" })
      ),
      updateAssistantMessageContent: () => false,
      updateAssistantMessageState: vi
        .fn<CreateChatTaskOptions["updateAssistantMessageState"]>()
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
    expect(run.logs.filter(({ level }) => level === "error")).toEqual([
      expect.objectContaining({
        err: expect.objectContaining({ message: persistenceFailure.message })
      })
    ])
    expect(run.settlement).toEqual({ status: "resolved" })
  })

  it("rejects with both failures and sends no event when the failed state cannot be stored", async () => {
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
      error: { errors: [streamFailure, persistenceFailure] }
    })
    expect(run.events).toEqual([])
  })
})
