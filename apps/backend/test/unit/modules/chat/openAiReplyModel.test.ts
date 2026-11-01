import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import { describe, expect, it, vi } from "vitest"
import type {
  ModelToolCall,
  ReplyStreamEvent,
  ReplyStreamRequest
} from "../../../../src/modules/agent/replyModel"
import ChatService from "../../../../src/modules/chat/chatService"
import OpenAiReplyModel from "../../../../src/modules/chat/openAiReplyModel"
import { ChatCompletionCancelledError } from "../../../../src/utils/errors"
import {
  createChatCompletionChunk,
  createChatCompletionStreamResponse,
  createFailedChatCompletionStreamResponse,
  createOpenAiErrorResponse,
  createOpenChatCompletionStreamResponse,
  startOpenAiEndpointFake
} from "../../support/openAiEndpointFake"
import {
  registerReplyModelContractSuite,
  type ReplyModelHarness,
  type ReplyModelScript
} from "../../support/replyModelContract"

/** Chat completion the adapter borrows. */
type CompleteChatStream = ConstructorParameters<typeof OpenAiReplyModel>[0]

/** Request every case sends. */
const REPLY_REQUEST = Object.freeze({
  messages: [
    { role: "system", content: "You are Lys." },
    { role: "user", content: "Hello", images: [] }
  ],
  tools: [],
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

/** Reasoning fields an OpenAI-compatible server adds to a delta. */
type ReasoningDeltaFields = Readonly<{
  /** Field LM Studio 0.4 and OpenRouter stream reasoning in. */
  reasoning?: unknown
  /** Field DeepSeek and llama.cpp stream reasoning in. */
  reasoning_content?: unknown
  /** Text the same delta carries; none by default. */
  content?: string
}>

/**
 * Creates a chunk whose first choice's delta carries reasoning fields, which
 * the SDK's types do not declare but its stream passes through.
 *
 * @param fields - Fields of the delta.
 * @returns A chunk with only that delta and no finish reason.
 */
function createReasoningChunk(
  fields: ReasoningDeltaFields
): ChatCompletionChunk {
  const delta = { content: null, ...fields }
  return {
    ...createChatCompletionChunk({}),
    choices: [{ index: 0, delta, finish_reason: null }]
  }
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

/**
 * Builds the chunks that stream one tool call: its name in the first
 * fragment, then its argument text split across two more.
 *
 * @param toolCall - Call the model makes.
 * @param index - Position of the call in its round.
 * @returns Three chunks carrying the call's fragments.
 */
function buildToolCallChunks(
  toolCall: ModelToolCall,
  index: number
): ChatCompletionChunk[] {
  const half = Math.floor(toolCall.argumentText.length / 2)
  const nameFragment = {
    index,
    id: `call_${index}`,
    type: "function" as const,
    function: { name: toolCall.toolName, arguments: "" }
  }
  const firstArguments = {
    index,
    function: { arguments: toolCall.argumentText.slice(0, half) }
  }
  const lastArguments = {
    index,
    function: { arguments: toolCall.argumentText.slice(half) }
  }
  return [
    createChatCompletionChunk({ toolCalls: [nameFragment] }),
    createChatCompletionChunk({ toolCalls: [firstArguments] }),
    createChatCompletionChunk({ toolCalls: [lastArguments] })
  ]
}

/**
 * Creates the endpoint response that carries out a reply model script.
 *
 * @param script - What the model does with the request.
 * @param handleRequestRelease - Called when an open reply's body is
 * cancelled, which is how the SDK releases the request.
 * @returns The response, or a promise that never settles for a request the
 * model does not accept.
 */
function createScriptedResponse(
  script: ReplyModelScript,
  handleRequestRelease: () => void
): Response | Promise<Response> {
  switch (script.kind) {
    case "finished-reply":
    case "unsupported-finish":
      return createChatCompletionStreamResponse([
        ...script.texts.map((content) =>
          createChatCompletionChunk({ content })
        ),
        createChatCompletionChunk({
          finishReason:
            script.kind === "finished-reply"
              ? script.finishReason
              : "content_filter"
        })
      ])
    case "tool-call-round":
      return createChatCompletionStreamResponse([
        ...script.texts.map((content) =>
          createChatCompletionChunk({ content })
        ),
        ...script.toolCalls.flatMap(buildToolCallChunks),
        createChatCompletionChunk({ finishReason: "tool_calls" })
      ])
    case "open-reply":
      return createOpenChatCompletionStreamResponse(
        script.texts.map((content) => createChatCompletionChunk({ content })),
        handleRequestRelease
      )
    case "failed-stream":
      return createFailedChatCompletionStreamResponse(
        script.texts.map((content) => createChatCompletionChunk({ content })),
        // Node's `fetch` fails a body this way when its connection ends early.
        new TypeError("terminated")
      )
    case "unaccepted-request":
      return new Promise<Response>(() => undefined)
    case "rejected-request":
      return createOpenAiErrorResponse(400, "model not loaded")
  }
}

/**
 * Creates an OpenAI reply model over a chat service whose in-process
 * endpoint answers every request as the script says, as the composition root
 * wires them.
 *
 * @param script - What the model does with each request.
 * @returns The reply model and the endpoint's observations.
 */
function createOpenAiReplyModelHarness(
  script: ReplyModelScript
): ReplyModelHarness {
  const modelRequest = Promise.withResolvers<void>()
  const requestRelease = Promise.withResolvers<void>()
  startOpenAiEndpointFake(() => {
    modelRequest.resolve()
    return createScriptedResponse(script, requestRelease.resolve)
  })
  const chatService = new ChatService({
    findChatEndpoint: () => ({
      baseUrl: "http://lmstudio.test/v1",
      apiKey: undefined,
      replyCeilingField: "max_completion_tokens"
    }),
    titleGenerationPrompt: "Summarize the message as a short title.",
    generatedTitleMaxLength: 50
  })
  return Object.freeze({
    replyModel: new OpenAiReplyModel((options) =>
      chatService.completeChatStream(options)
    ),
    waitForModelRequest: () => modelRequest.promise,
    waitForRequestRelease: () => requestRelease.promise
  })
}

describe("OpenAiReplyModel", () => {
  registerReplyModelContractSuite(createOpenAiReplyModelHarness)

  it("sends the context, model, generation options, and signal to the chat completion", async () => {
    const completeChatStream = createChunkStream()

    await listReplyStreamEvents(completeChatStream)

    expect(completeChatStream).toHaveBeenCalledWith({
      messages: [
        { role: "system", content: "You are Lys." },
        { role: "user", content: "Hello" }
      ],
      tools: [],
      model: REPLY_REQUEST.model,
      generationOptions: REPLY_REQUEST.generationOptions,
      signal: REPLY_REQUEST.abortSignal
    })
  })

  it("sends the offered tools and every context message kind to the chat completion", async () => {
    const completeChatStream = createChunkStream()
    const toolCall = {
      id: "01900000-0000-7000-8000-00000000000a",
      toolName: "read_text_file",
      argumentText: '{"path":"/notes/todo.md"}'
    }
    const readTextFile = {
      type: "function",
      function: {
        name: "read_text_file",
        description: "Read one text file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Path." } },
          required: ["path"],
          additionalProperties: false
        }
      }
    } as const

    await new OpenAiReplyModel(completeChatStream).openReplyStream({
      ...REPLY_REQUEST,
      tools: [readTextFile],
      messages: [
        { role: "system", content: "You are Lys." },
        { role: "user", content: "What is on my list?", images: [] },
        { role: "assistant", content: "Let me look.", toolCalls: [toolCall] },
        { role: "tool", toolCallId: toolCall.id, content: "Buy milk" },
        { role: "assistant", content: "Earlier answer", toolCalls: [] }
      ]
    })

    expect(completeChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [readTextFile],
        messages: [
          { role: "system", content: "You are Lys." },
          { role: "user", content: "What is on my list?" },
          {
            role: "assistant",
            content: "Let me look.",
            tool_calls: [
              {
                id: toolCall.id,
                type: "function",
                function: {
                  name: "read_text_file",
                  arguments: '{"path":"/notes/todo.md"}'
                }
              }
            ]
          },
          { role: "tool", tool_call_id: toolCall.id, content: "Buy milk" },
          { role: "assistant", content: "Earlier answer" }
        ]
      })
    )
  })

  it("sends a user message with images as its text part followed by one data URL part per image", async () => {
    const completeChatStream = createChunkStream()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff])

    await new OpenAiReplyModel(completeChatStream).openReplyStream({
      ...REPLY_REQUEST,
      messages: [
        { role: "system", content: "You are Lys." },
        {
          role: "user",
          content: "What is this?",
          images: [
            { mediaType: "image/png", width: 2, height: 2, data: png },
            { mediaType: "image/jpeg", width: 3, height: 1, data: jpeg }
          ]
        }
      ]
    })

    expect(completeChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "You are Lys." },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`
                }
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`
                }
              }
            ]
          }
        ]
      })
    )
  })

  it("builds each call from fragments that interleave and split its name, in index order", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createChatCompletionChunk({
          toolCalls: [
            { index: 1, function: { name: "search_", arguments: "" } }
          ]
        }),
        createChatCompletionChunk({
          toolCalls: [{ index: 0, function: { name: "read_text_file" } }]
        }),
        createChatCompletionChunk({
          toolCalls: [
            { index: 1, function: { name: "files", arguments: "{}" } }
          ]
        }),
        createChatCompletionChunk({
          toolCalls: [{ index: 0, function: { arguments: '{"path":"/a"}' } }]
        }),
        createChatCompletionChunk({ finishReason: "tool_calls" })
      )
    )

    expect(run.events).toEqual([
      {
        type: "tool-calls",
        toolCalls: [
          { toolName: "read_text_file", argumentText: '{"path":"/a"}' },
          { toolName: "search_files", argumentText: "{}" }
        ]
      }
    ])
  })

  it("ends the round with its tool calls when the model reports stop after sending them", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createChatCompletionChunk({
          toolCalls: [
            { index: 0, function: { name: "read_text_file", arguments: "{}" } }
          ]
        }),
        createChatCompletionChunk({ finishReason: "stop" })
      )
    )

    expect(run.events).toEqual([
      {
        type: "tool-calls",
        toolCalls: [{ toolName: "read_text_file", argumentText: "{}" }]
      }
    ])
  })

  it("drops a call cut off by the length limit and finishes the reply with length", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createChatCompletionChunk({ content: "Let me" }),
        createChatCompletionChunk({
          toolCalls: [
            {
              index: 0,
              function: { name: "read_text_file", arguments: '{"pa' }
            }
          ]
        }),
        createChatCompletionChunk({ finishReason: "length" })
      )
    )

    expect(run.events).toEqual([
      { type: "text", content: "Let me" },
      { type: "finish", finishReason: "length" }
    ])
  })

  it("fails when the model reports tool calls without sending any", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createChatCompletionChunk({ finishReason: "tool_calls" })
      )
    )

    expect(run.events).toEqual([])
    expect(run.failure).toEqual(
      new Error("Model asked for tool calls without sending any")
    )
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

  it("yields the reasoning field before the text of the same chunk", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createReasoningChunk({ reasoning: "They greet me." }),
        createReasoningChunk({ reasoning: " Greet back.", content: "Hi" }),
        createChatCompletionChunk({ finishReason: "stop" })
      )
    )

    expect(run.events).toEqual([
      { type: "reasoning", content: "They greet me." },
      { type: "reasoning", content: " Greet back." },
      { type: "text", content: "Hi" },
      { type: "finish", finishReason: "stop" }
    ])
  })

  it("yields a chunk's reasoning, then its text, then the finish reason it carries", async () => {
    const chunk = createReasoningChunk({ reasoning: "Short.", content: "Hi" })
    const finishingChunk: ChatCompletionChunk = {
      ...chunk,
      choices: chunk.choices.map((choice) => ({
        ...choice,
        finish_reason: "stop"
      }))
    }

    const run = await listReplyStreamEvents(createChunkStream(finishingChunk))

    expect(run.events).toEqual([
      { type: "reasoning", content: "Short." },
      { type: "text", content: "Hi" },
      { type: "finish", finishReason: "stop" }
    ])
  })

  it("reads reasoning_content when a delta has no reasoning text, and prefers reasoning when it has both", async () => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createReasoningChunk({ reasoning_content: "First" }),
        createReasoningChunk({ reasoning: "", reasoning_content: "Second" }),
        createReasoningChunk({ reasoning: "Third", reasoning_content: "Not" }),
        createChatCompletionChunk({ finishReason: "stop" })
      )
    )

    expect(run.events).toEqual([
      { type: "reasoning", content: "First" },
      { type: "reasoning", content: "Second" },
      { type: "reasoning", content: "Third" },
      { type: "finish", finishReason: "stop" }
    ])
  })

  it.each([
    ["an empty reasoning field", { reasoning: "" }],
    ["a reasoning field that is not text", { reasoning: 42 }],
    ["a null reasoning_content field", { reasoning_content: null }],
    [
      "a reasoning_content field that is not text",
      { reasoning_content: { text: "x" } }
    ]
  ])("yields no reasoning for %s", async (_label, fields) => {
    const run = await listReplyStreamEvents(
      createChunkStream(
        createReasoningChunk(fields),
        createChatCompletionChunk({ finishReason: "stop" })
      )
    )

    expect(run.events).toEqual([{ type: "finish", finishReason: "stop" }])
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
        createChatCompletionChunk({ finishReason: "content_filter" })
      )
    )

    expect(run.events).toEqual([{ type: "text", content: "Hi" }])
    expect(run.failure).toEqual(new Error("Unsupported chat finish reason"))
  })

  it("passes a failure of the chat completion stream through unchanged after the earlier text", async () => {
    const failure = new TypeError("terminated")

    const run = await listReplyStreamEvents(
      vi.fn<CompleteChatStream>(async () =>
        (async function* () {
          yield createChatCompletionChunk({ content: "Hi" })
          throw failure
        })()
      )
    )

    expect(run.events).toEqual([{ type: "text", content: "Hi" }])
    expect(run.failure).toBe(failure)
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
})
