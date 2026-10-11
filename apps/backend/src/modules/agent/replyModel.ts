import type { MessageGenerationOptions } from "@lys/protocol"
import type {
  ConversationAssistantMessageFinishReason,
  OpenAIFunctionTool
} from "@lys/share"

/** One tool call a model asked for in a reply round, as the model wrote it. */
export type ModelToolCall = Readonly<{
  /** Name the model called; it may name a tool that was not offered. */
  toolName: string
  /** Argument text as the model wrote it; untrusted and possibly not JSON. */
  argumentText: string
}>

/** One tool call of an earlier round, as the context sends it back. */
export type ContextToolCall = Readonly<{
  /** UUIDv7 the backend gave the call; pairs it with its result. */
  id: string
  /** Name the model called. */
  toolName: string
  /** Argument text as the model wrote it. */
  argumentText: string
}>

/** One message of the context an agent sends to its model. */
export type ReplyContextMessage =
  | Readonly<{
      /** The agent's instructions or the person's text. */
      role: "system" | "user"
      /** Text sent to the model as written. */
      content: string
    }>
  | Readonly<{
      /** Text the agent wrote, and the tools it called in the same round. */
      role: "assistant"
      /** Text sent to the model as written; empty for a round of calls only. */
      content: string
      /**
       * Calls the agent made after the text, in its order; empty for a
       * stored reply.
       */
      toolCalls: readonly ContextToolCall[]
    }>
  | Readonly<{
      /** The result of one tool call. */
      role: "tool"
      /** Identifier of the call this result answers. */
      toolCallId: string
      /** Text the model reads as the result. */
      content: string
    }>

/** Context and settings of one reply stream. */
export type ReplyStreamRequest = Readonly<{
  /** Context in send order: the system prompt first, then the conversation. */
  messages: readonly ReplyContextMessage[]
  /** Tools the model may call, in offer order; empty when none are offered. */
  tools: readonly OpenAIFunctionTool[]
  /** Identifier of the model that writes the reply. */
  model: string
  /** Sampling and reply length controls. */
  generationOptions: MessageGenerationOptions
  /** Cancels opening the stream and the stream itself. */
  abortSignal: AbortSignal
}>

/** One event of a reply stream, in the order the model produced it. */
export type ReplyStreamEvent =
  | Readonly<{
      /** The model produced more reply text. */
      type: "text"
      /** Nonempty text that follows the earlier text. */
      content: string
    }>
  | Readonly<{
      /** The model ended the reply. */
      type: "finish"
      /** Supported reason the reply ended. */
      finishReason: ConversationAssistantMessageFinishReason
    }>
  | Readonly<{
      /** The model ended the round by calling tools instead of finishing. */
      type: "tool-calls"
      /** Calls in the model's order; at least one. */
      toolCalls: readonly ModelToolCall[]
    }>

/**
 * A reply model can open one reply stream for a context.
 *
 * @remarks Implementations may serve overlapping streams; each request owns
 * its own stream and cancellation.
 */
export interface ReplyModel {
  /**
   * Opens a reply stream for one context.
   *
   * @param request - Context, offered tools, model, generation controls, and
   * cancellation; borrowed until the stream ends.
   * @returns A promise resolving once the model accepted the request, to the
   * reply's events in order. A `finish` event ends the reply; a `tool-calls`
   * event ends the round. Leaving the
   * iteration early releases the model request. Cancelling the request after
   * the model accepted it also releases the request: the stream then ends
   * early, possibly before the event that ends it, or rejects with the
   * model's own failure.
   * @throws `ChatCompletionCancelledError` If the request is cancelled before
   * the model accepts it.
   * @throws If the model rejects the request, or the stream fails, carries a
   * finish reason other than `stop`, `length`, or a tool call, or reports tool
   * calls without sending any; the stream rejects with that failure after the
   * events before it.
   */
  openReplyStream(
    request: ReplyStreamRequest
  ): Promise<AsyncIterable<ReplyStreamEvent>>
}
