import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import { describe, expect, it, vi } from "vitest"
import type {
  ReplyStreamEvent,
  ReplyStreamRequest
} from "../../../../src/modules/agent/replyModel"
import OpenAiReplyModel from "../../../../src/modules/chat/openAiReplyModel"
import { ChatCompletionCancelledError } from "../../../../src/utils/errors"
import { createChatCompletionChunk } from "../../support/openAiEndpointFake"

/** Chat completion the adapter borrows. */
type CompleteChatStream = ConstructorParameters<typeof OpenAiReplyModel>[0]

/** Request every case sends. */
const REPLY_REQUEST = Object.freeze({
  messages: [
    { role: "system", content: "You are Lys." },
    { role: "user", content: "Hello" }
  ],
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4, replyCeiling: 128 },
  abortSignal: new AbortController().signal
} satisfies ReplyStreamRequest)

/**
 * Creates a chat completion whose stream yields fixed chunks.
 *
 * @param chunks - Chunks yielded in order.
 * @returns A completion function recording its inputs.
 */
function createChunkStream(...chunks: ChatCompletionChunk[]) {
  return vi.fn<CompleteChatStream>(async () =>
    (async function* () {
      yield* chunks
    })()
  )
}

/**
 * Reads a reply stream to its end or failure.
 *
 * @param completeChatStream - Chat completion behind the adapter.
 * @returns The events read and the failure that ended the stream, if any.
 */
async function listReplyStreamEvents(completeChatStream: CompleteChatStream) {
  const events: ReplyStreamEvent[] = []
  const stream = await new OpenAiReplyModel(completeChatStream).openReplyStream(
    REPLY_REQUEST
  )
  try {
    for await (const event of stream) events.push(event)
    return { events, failure: undefined }
  } catch (failure) {
    return { events, failure }
  }
}

describe("OpenAiReplyModel", () => {
  it("sends the context, model, generation options, and signal to the chat completion", async () => {
    const completeChatStream = createChunkStream()

    await listReplyStreamEvents(completeChatStream)

    expect(completeChatStream).toHaveBeenCalledWith({
      messages: [
        { role: "system", content: "You are Lys." },
        { role: "user", content: "Hello" }
      ],
      model: REPLY_REQUEST.model,
      generationOptions: REPLY_REQUEST.generationOptions,
      signal: REPLY_REQUEST.abortSignal
    })
  })

  it("yields the first choice's text, then its finish reason", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createChatCompletionChunk({ content: "Hi" }),
        createChatCompletionChunk({ content: " there" }),
        createChatCompletionChunk({ finishReason: "stop" })
      )
    )

    expect(run).toEqual({
      events: [
        { type: "text", content: "Hi" },
        { type: "text", content: " there" },
        { type: "finish", finishReason: "stop" }
      ],
      failure: undefined
    })
  })

  it("yields text before the finish reason carried by the same chunk", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createChatCompletionChunk({ content: "Cut", finishReason: "length" })
      )
    )

    expect(run.events).toEqual([
      { type: "text", content: "Cut" },
      { type: "finish", finishReason: "length" }
    ])
  })

  it("skips chunks without text or without the first choice", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        { ...createChatCompletionChunk({}), choices: [] },
        createChatCompletionChunk({ content: "other choice", index: 1 }),
        createChatCompletionChunk({ content: null }),
        createChatCompletionChunk({ content: "" }),
        createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
      )
    )

    expect(run.events).toEqual([
      { type: "text", content: "Hi" },
      { type: "finish", finishReason: "stop" }
    ])
  })

  it("fails on an unsupported finish reason after the earlier text", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createChatCompletionChunk({ content: "Hi" }),
        createChatCompletionChunk({ finishReason: "tool_calls" })
      )
    )

    expect(run.events).toEqual([{ type: "text", content: "Hi" }])
    expect(run.failure).toEqual(new Error("Unsupported chat finish reason"))
  })

  it("passes a rejected chat completion through unchanged", async () => {
    const cancellation = new ChatCompletionCancelledError(new Error("aborted"))
    const model = new OpenAiReplyModel(
      vi.fn<CompleteChatStream>(async () => {
        throw cancellation
      })
    )

    await expect(model.openReplyStream(REPLY_REQUEST)).rejects.toBe(
      cancellation
    )
  })

  it("releases the chat completion stream when its reader stops early", async () => {
    let isUpstreamReleased = false
    const stream = await new OpenAiReplyModel(
      vi.fn<CompleteChatStream>(async () =>
        (async function* () {
          try {
            yield createChatCompletionChunk({ content: "Hi" })
            yield createChatCompletionChunk({ content: "unread" })
          } finally {
            isUpstreamReleased = true
          }
        })()
      )
    ).openReplyStream(REPLY_REQUEST)

    for await (const event of stream) {
      expect(event).toEqual({ type: "text", content: "Hi" })
      break
    }

    expect(isUpstreamReleased).toBe(true)
  })
})
