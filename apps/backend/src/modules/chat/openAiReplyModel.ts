import type { ConversationAssistantMessageFinishReason } from "@lys/share"
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam
} from "openai/resources/index.mjs"
import type {
  ContextToolCall,
  ModelToolCall,
  ReplyContextMessage,
  ReplyModel,
  ReplyStreamEvent,
  ReplyStreamRequest
} from "../agent/replyModel"
import type { CompleteChatOptions } from "./chatService"

/** Starts a streamed chat completion; the returned iterator owns upstream cleanup. */
type CompleteChatStream = (
  options: CompleteChatOptions
) => Promise<AsyncIterable<ChatCompletionChunk>>

/** One streamed fragment of a tool call, as an OpenAI-compatible chunk carries it. */
type ToolCallFragment = ChatCompletionChunk.Choice.Delta.ToolCall

/** Upstream reason a streamed choice ended. */
type ChatFinishReason = NonNullable<ChatCompletionChunk.Choice["finish_reason"]>

/** Context message the agent wrote in an earlier round. */
type AssistantContextMessage = Extract<
  ReplyContextMessage,
  { role: "assistant" }
>

/**
 * Translates a borrowed OpenAI-compatible streamed chat completion into agent
 * reply streams.
 *
 * @remarks Implements {@link ReplyModel}. Text events and the round's tool
 * calls come from the choice with index 0; a chunk without it is skipped, and
 * empty or absent text produces no event. Owns no resource: the chat
 * completion's owner releases its client. Concurrency model: reentrant; it
 * keeps no state and the chat completion permits overlapping requests.
 */
export default class OpenAiReplyModel implements ReplyModel {
  /** Borrowed streamed chat completion of the backend's chat service. */
  readonly #completeChatStream: CompleteChatStream

  /**
   * Creates the adapter without contacting the endpoint.
   * @param completeChatStream - Streamed chat completion lent for the
   * adapter's lifetime.
   */
  public constructor(completeChatStream: CompleteChatStream) {
    this.#completeChatStream = completeChatStream
  }

  /**
   * Implements {@link ReplyModel.openReplyStream}.
   * @param request - Interface-defined request; its signal cancels the
   * completion request and stream.
   * @returns The interface-defined stream; leaving it early releases the
   * completion stream.
   * @throws The chat completion's failures unchanged, including
   * `ChatCompletionCancelledError`; the stream rejects with
   * `Unsupported chat finish reason` for a finish reason other than `stop`,
   * `length`, or a tool call, and with
   * `Model asked for tool calls without sending any` for a tool-call finish
   * without calls.
   */
  public async openReplyStream(
    request: ReplyStreamRequest
  ): Promise<AsyncIterable<ReplyStreamEvent>> {
    const chunks = await this.#completeChatStream({
      messages: request.messages.map(buildChatCompletionMessage),
      tools: request.tools,
      model: request.model,
      generationOptions: request.generationOptions,
      signal: request.abortSignal
    })
    return parseReplyStreamEvents(chunks)
  }
}

/**
 * Translates streamed chat completion chunks into reply events.
 *
 * @param chunks - Upstream chunks, owned by the returned stream.
 * @returns Text events in chunk order, then the event that ends the round: a
 * `finish`, or `tool-calls` built from the round's tool-call fragments. A
 * chunk carrying both text and a finish reason yields the text first.
 * Leaving the iteration early releases the chunks.
 * @throws If the upstream fails, a chunk carries an unsupported finish
 * reason, or the model reports tool calls without sending any.
 */
async function* parseReplyStreamEvents(
  chunks: AsyncIterable<ChatCompletionChunk>
): AsyncGenerator<ReplyStreamEvent, void, undefined> {
  let toolCallFragments: readonly ToolCallFragment[] = []
  for await (const chunk of chunks) {
    const choice = chunk.choices.find(({ index }) => index === 0)
    if (choice === undefined) continue
    const content = choice.delta.content
    if (content) yield { type: "text", content }
    toolCallFragments = [
      ...toolCallFragments,
      ...(choice.delta.tool_calls ?? [])
    ]
    const finishReason = choice.finish_reason
    if (finishReason) yield buildRoundEndEvent(finishReason, toolCallFragments)
  }
}

/**
 * Builds the event that ends one round.
 *
 * @param finishReason - Upstream reason the choice ended.
 * @param toolCallFragments - Every tool-call fragment of the round, in stream
 * order.
 * @returns `tool-calls` for a tool-call finish, and for a `stop` finish after
 * tool-call fragments, which some OpenAI-compatible servers send; otherwise
 * `finish`. A `length` finish drops the fragments: a call cut off by the
 * length limit is incomplete.
 * @throws `Model asked for tool calls without sending any` for a tool-call
 * finish without fragments; `Unsupported chat finish reason` for a reason
 * other than `stop`, `length`, or a tool call.
 */
function buildRoundEndEvent(
  finishReason: ChatFinishReason,
  toolCallFragments: readonly ToolCallFragment[]
): ReplyStreamEvent {
  if (!isToolCallFinish(finishReason, toolCallFragments))
    return { type: "finish", finishReason: parseFinishReason(finishReason) }
  if (toolCallFragments.length === 0)
    throw new Error("Model asked for tool calls without sending any")
  return {
    type: "tool-calls",
    toolCalls: buildModelToolCalls(toolCallFragments)
  }
}

/**
 * Answers whether a finish reason ends the round with tool calls.
 *
 * @param finishReason - Upstream reason the choice ended.
 * @param toolCallFragments - Tool-call fragments of the round.
 * @returns True for `tool_calls`, and for `stop` after any fragment.
 */
function isToolCallFinish(
  finishReason: ChatFinishReason,
  toolCallFragments: readonly ToolCallFragment[]
): boolean {
  return (
    finishReason === "tool_calls" ||
    (finishReason === "stop" && toolCallFragments.length > 0)
  )
}

/**
 * Builds the calls of one round from their streamed fragments.
 *
 * @param toolCallFragments - Fragments in stream order; fragments with one
 * `index` belong to one call.
 * @returns One frozen call per index, in index order.
 */
function buildModelToolCalls(
  toolCallFragments: readonly ToolCallFragment[]
): readonly ModelToolCall[] {
  const callIndexes = [
    ...new Set(toolCallFragments.map(({ index }) => index))
  ].toSorted((left, right) => left - right)
  return Object.freeze(
    callIndexes.map((callIndex) =>
      buildModelToolCall(
        toolCallFragments.filter(({ index }) => index === callIndex)
      )
    )
  )
}

/**
 * Builds one call from its fragments.
 *
 * @param fragments - The call's fragments in stream order.
 * @returns The call whose name and argument text are its fragments' pieces
 * joined in stream order.
 */
function buildModelToolCall(
  fragments: readonly ToolCallFragment[]
): ModelToolCall {
  const toolName = fragments
    .map((fragment) => fragment.function?.name ?? "")
    .join("")
  const argumentText = fragments
    .map((fragment) => fragment.function?.arguments ?? "")
    .join("")
  return Object.freeze({ toolName, argumentText })
}

/**
 * Builds the chat completion message of one context message.
 *
 * @param message - Context message in the agent's representation.
 * @returns The same message in the OpenAI-compatible request format.
 */
function buildChatCompletionMessage(
  message: ReplyContextMessage
): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content }
    case "user":
      return { role: "user", content: message.content }
    case "assistant":
      return buildAssistantCompletionMessage(message)
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content
      }
  }
}

/**
 * Builds the chat completion message of the agent's text and calls.
 *
 * @param message - Assistant context message.
 * @returns The text alone when the message has no calls; otherwise the text
 * with its calls.
 */
function buildAssistantCompletionMessage(
  message: AssistantContextMessage
): ChatCompletionAssistantMessageParam {
  if (message.toolCalls.length === 0)
    return { role: "assistant", content: message.content }
  const toolCalls = message.toolCalls.map(buildCompletionToolCall)
  return { role: "assistant", content: message.content, tool_calls: toolCalls }
}

/**
 * Builds the request form of one earlier call.
 *
 * @param toolCall - Call from the context.
 * @returns A function tool call carrying the model's own argument text.
 */
function buildCompletionToolCall(
  toolCall: ContextToolCall
): ChatCompletionMessageFunctionToolCall {
  const toolFunction = {
    name: toolCall.toolName,
    arguments: toolCall.argumentText
  }
  return { id: toolCall.id, type: "function", function: toolFunction }
}

/**
 * Accepts the finish reasons a reply can be stored with.
 *
 * @param finishReason - Upstream reason the choice ended.
 * @returns The same reason when it is `stop` or `length`.
 * @throws `Unsupported chat finish reason` for any other reason, such as
 * `content_filter`.
 */
function parseFinishReason(
  finishReason: ChatFinishReason
): ConversationAssistantMessageFinishReason {
  if (finishReason !== "stop" && finishReason !== "length")
    throw new Error("Unsupported chat finish reason")
  return finishReason
}
