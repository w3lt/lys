import type {
  ChatGenerationEvent,
  MessageGenerationOptions
} from "@lys/protocol"
import type {
  ConversationAssistantMessageFinishReason,
  ConversationMessage
} from "@lys/share"
import type { FastifyBaseLogger } from "fastify"
import { ChatCompletionCancelledError } from "../../utils/errors"
import { buildAgentContext } from "./agentContext"
import type { ReplyModel } from "./replyModel"

/** What an agent knows about itself to answer turns. */
export type AgentProfile = Readonly<{
  /**
   * Valid agent code, stored on every conversation the agent starts and
   * compared exactly when a turn looks its agent up.
   */
  code: string
  /** Non-empty instructions sent first in every context the agent builds. */
  systemPrompt: string
}>

/** Valid terminal assistant state; only completed replies carry a finish reason. */
export type AssistantMessageCompletion =
  | Readonly<{
      /** The upstream supplied a supported completion reason. */
      status: "completed"
      /** Supported terminal model reason. */
      finishReason: ConversationAssistantMessageFinishReason
    }>
  | Readonly<{
      /** Cancellation preserves partial content; failure is retained but excluded from context. */
      status: "interrupted" | "failed"
    }>

/**
 * One turn an agent answers, with the capabilities it uses to store and
 * publish the reply.
 */
export type AgentTurn = Readonly<{
  /** Stored transcript before this turn, in conversation order. */
  history: readonly ConversationMessage[]
  /** Text of the user message this turn answers. */
  userMessageContent: string
  /** Model selected by the request. */
  model: string
  /** Caller-provided sampling and reply length controls. */
  generationOptions: MessageGenerationOptions
  /** Generation-owned cancellation, aborted by Stop or shutdown. */
  abortSignal: AbortSignal
  /** Stores one delta before it is sent; false after deletion or finalization. */
  updateAssistantMessageContent: (content: string) => boolean
  /** Stores the final state; false after deletion or prior finalization. */
  updateAssistantMessageState: (
    completion: AssistantMessageCompletion
  ) => boolean
  /** Queues one event for every stream following the reply; never waits. */
  sendEvent: (event: ChatGenerationEvent) => void
  /** Logger that records reply failures. */
  logger: FastifyBaseLogger
}>

/**
 * Retains one agent's profile and borrowed model access to answer
 * conversation turns as that agent.
 *
 * @remarks Every context the agent builds starts with its own system prompt,
 * never one stored with the conversation. It keeps no state between or during
 * turns, so one instance answers overlapping turns, each through its own
 * {@link AgentTurn}, as long as the model access permits overlapping streams.
 * Owns no resource: the model's owner releases it. Concurrency model:
 * reentrant.
 */
export default class Agent {
  /** Code stored on the conversations this agent answers. */
  readonly #code: string
  /** Instructions sent first in every context. */
  readonly #systemPrompt: string
  /** Borrowed model access that writes every reply. */
  readonly #replyModel: ReplyModel

  /**
   * Creates a ready agent without contacting its model.
   * @param profile - Trusted code and system prompt of the agent.
   * @param replyModel - Model access lent for the agent's lifetime.
   */
  public constructor(profile: AgentProfile, replyModel: ReplyModel) {
    this.#code = profile.code
    this.#systemPrompt = profile.systemPrompt
    this.#replyModel = replyModel
  }

  /**
   * Code of this agent.
   * @returns The valid agent code given at creation; it never changes.
   */
  public get code(): string {
    return this.#code
  }

  /**
   * Answers one turn, storing each delta before sending it and the final
   * state before the final event.
   *
   * @param turn - Context, request settings, cancellation, reply storage, and
   * event sender, borrowed until the returned promise settles.
   * @returns Settlement after completion, cancellation, supersession,
   * deletion, or a reported failure.
   * @throws An `AggregateError` holding the failure that ended the reply
   * followed by the persistence failure, when the failed or interrupted state
   * cannot be stored after that failure; the generation reports that
   * rejection. A delta, completion, or interrupted-state write that throws
   * before that point is itself handled as the failure that ended the reply.
   * @remarks When the reply settles without throwing it has sent exactly one
   * final event: `done` after a stored completion; `interrupted` after
   * cancellation, or when a newer turn or a deletion ended the reply; `error`
   * after a model failure. Partial text stays stored. Interrupted replies stay
   * in later context; failed replies do not. Each failure is logged with the
   * failure as `err`: at debug level when the turn was cancelled or the model
   * reports a cancellation, and at error level otherwise.
   */
  public async createReply(turn: AgentTurn): Promise<void> {
    try {
      const finishReason = await this.#createReplyText(turn)
      if (finishReason === undefined) {
        turn.updateAssistantMessageState({ status: "interrupted" })
        turn.sendEvent({ type: "interrupted" })
        return
      }
      const persisted = turn.updateAssistantMessageState({
        status: "completed",
        finishReason
      })
      // A reply already finalized elsewhere was superseded by a newer turn or
      // deleted, so it did not complete here.
      turn.sendEvent(
        persisted ? { type: "done", finishReason } : { type: "interrupted" }
      )
    } catch (error) {
      handleReplyFailure(turn, error)
    }
  }

  /**
   * Streams the model's reply to one turn, storing every text before sending
   * it.
   *
   * @param turn - Turn context, reply storage, and cancellation.
   * @returns The supported finish reason, or undefined after cancellation,
   * supersession, or deletion.
   * @throws If the model fails, its stream ends without a finish reason, or a
   * delta cannot be stored.
   * @remarks Storing and sending happen in one synchronous step, so a follower
   * that reads a snapshot in its own step sees either both or neither.
   * Leaving the stream early releases the model request.
   */
  async #createReplyText(
    turn: AgentTurn
  ): Promise<ConversationAssistantMessageFinishReason | undefined> {
    if (turn.abortSignal.aborted) return undefined
    const stream = await this.#replyModel.openReplyStream({
      messages: buildAgentContext(
        this.#systemPrompt,
        turn.history,
        turn.userMessageContent
      ),
      model: turn.model,
      generationOptions: turn.generationOptions,
      abortSignal: turn.abortSignal
    })
    for await (const event of stream) {
      if (turn.abortSignal.aborted) return undefined
      if (event.type === "finish") return event.finishReason
      if (!turn.updateAssistantMessageContent(event.content)) return undefined
      turn.sendEvent({ type: "delta", content: event.content })
    }
    if (turn.abortSignal.aborted) return undefined
    throw new Error("Model stream ended without a finish reason")
  }
}

/**
 * Stores and reports a reply that failed or was cancelled.
 *
 * @param turn - Turn-scoped persistence, logger, cancellation, and sender.
 * @param error - Failure raised while answering.
 * @throws An `AggregateError` holding `error` followed by the persistence
 * failure when the terminal state cannot be stored.
 * @remarks The model reports a cancelled request even when the agent has not
 * yet observed its own abort, so both mean an interrupted reply. Any other
 * failure stores `failed` and sends an `error` event. Both are logged as
 * {@link Agent.createReply} describes.
 */
function handleReplyFailure(turn: AgentTurn, error: unknown): void {
  const isCancelled =
    turn.abortSignal.aborted || error instanceof ChatCompletionCancelledError
  if (isCancelled) {
    turn.logger.debug({ err: error }, "Chat completion was cancelled")
  } else {
    turn.logger.error({ err: error }, "Chat completion stream failed")
  }
  try {
    turn.updateAssistantMessageState({
      status: isCancelled ? "interrupted" : "failed"
    })
  } catch (persistenceFailure) {
    throw new AggregateError(
      [error, persistenceFailure],
      "Chat failure could not be finalized",
      { cause: persistenceFailure }
    )
  }
  turn.sendEvent(
    isCancelled
      ? { type: "interrupted" }
      : { type: "error", message: "Chat completion failed. Please try again." }
  )
}
