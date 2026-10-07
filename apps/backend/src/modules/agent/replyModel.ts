import type { MessageGenerationOptions } from "@lys/protocol"
import type { ConversationAssistantMessageFinishReason } from "@lys/share"

/** One message of the context an agent sends to its model. */
export type ReplyContextMessage = Readonly<{
  /** Author of the text: the agent's instructions, the person, or the agent. */
  role: "system" | "user" | "assistant"
  /** Text sent to the model as written. */
  content: string
}>

/** Context and settings of one reply stream. */
export type ReplyStreamRequest = Readonly<{
  /** Context in send order: the system prompt first, the new message last. */
  messages: readonly ReplyContextMessage[]
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
   * @param request - Context, model, generation controls, and cancellation;
   * borrowed until the stream ends.
   * @returns A promise resolving once the model accepted the request, to the
   * reply's events in order. A `finish` event ends the reply. Leaving the
   * iteration early releases the model request. Cancelling the request after
   * the model accepted it also releases the request: the stream then ends
   * early, possibly before a `finish` event, or rejects with the model's own
   * failure.
   * @throws `ChatCompletionCancelledError` If the request is cancelled before
   * the model accepts it.
   * @throws If the model rejects the request, or the stream fails or carries
   * a finish reason other than `stop` or `length`; the stream rejects with
   * that failure after the events before it.
   */
  openReplyStream(
    request: ReplyStreamRequest
  ): Promise<AsyncIterable<ReplyStreamEvent>>
}
