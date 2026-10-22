import type { OpenAIFunctionTool } from "@lys/share"
import type { ReplyContextImageSides, ReplyContextMessage } from "./replyModel"

/** Context, offered tools, and model of one request to the model. */
export type ReplyContextMeasurementRequest = Readonly<{
  /**
   * Context in send order: the system prompt first, then the conversation.
   * Each image needs only its sides, which its tokens are estimated from.
   */
  messages: readonly ReplyContextMessage<ReplyContextImageSides>[]
  /** Tools offered with the context, in offer order; empty when none are. */
  tools: readonly OpenAIFunctionTool[]
  /** Identifier of the model the request is sent to. */
  model: string
}>

/**
 * How much of the model's context window one request takes, in tokens of the
 * model's own tokenizer.
 */
export type ReplyContextMeasurement = Readonly<{
  /** Context length the model is loaded with; a positive integer. */
  contextLength: number
  /**
   * Tokens of each message, in send order, including the markup the chat
   * template adds around it; whole numbers ≥ 0.
   */
  messageTokenCounts: readonly number[]
  /**
   * Tokens of every offered tool together, including the markup the chat
   * template adds around them; 0 when no tool is offered.
   */
  toolTokenCount: number
}>

/**
 * A reply context meter can find how much of a loaded model's context window
 * a request takes before it is sent.
 *
 * @remarks Implementations are ready when injected and own no resource the
 * consumer releases. A measurement is an observation: the model can be
 * unloaded or loaded again with another context length right after it.
 */
export interface ReplyContextMeter {
  /**
   * Finds how much of the model's context window a request takes.
   *
   * @param request - Context, offered tools, and model; borrowed until the
   * returned promise settles.
   * @returns A promise resolving to a frozen measurement with one count per
   * message, in message order; or to undefined when the model is not loaded,
   * so no measurement exists. It never loads the model.
   * @throws If the model's runtime cannot be reached, is busy, or answers
   * with a failure; nothing is sent to the model.
   * @remarks Completion-only: the meter's owner keeps an accepted
   * measurement until it settles, independently of the caller, so a caller
   * that stops waiting leaves it running. It may wait behind other model
   * operations, such as a load.
   */
  findReplyContextMeasurement(
    request: ReplyContextMeasurementRequest
  ): Promise<ReplyContextMeasurement | undefined>
}
