import type {
  ChatGenerationEvent,
  MessageGenerationOptions
} from "@lys/protocol"
import type {
  ConversationAssistantMessageFinishReason,
  ConversationMessage,
  OpenAIFunctionTool,
  ToolDefinition
} from "@lys/share"
import { ChatCompletionCancelledError } from "../../utils/errors"
import { buildAgentContext } from "./agentContext"
import type { ReplyContextMessage, ReplyModel } from "./replyModel"
import {
  buildAgentToolset,
  buildOfferedTools,
  handleToolCallRound,
  type SendToolCall,
  type ToolCallRound
} from "./toolCallRound"

/** Text stored before a later round's first text when an earlier round stored text. */
const ROUND_TEXT_SEPARATOR = "\n\n"

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
 * One turn an agent answers, with the capabilities it uses to store, publish,
 * and report the reply.
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
  /** Client tools offered for the turn, each name once; empty when none are. */
  tools: readonly ToolDefinition[]
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
  /**
   * Sends one checked tool call to every stream following the reply and
   * waits for the client's answer; resolves with undefined when the reply was
   * stopped or shut down while the call waited. Never rejects.
   */
  sendToolCall: SendToolCall
  /**
   * Receives the failure that ended a reply cancelled by Stop or shutdown, or
   * reported as cancelled by the model.
   */
  reportReplyCancellation: (failure: unknown) => void
  /** Receives the failure that ended a reply stored as failed. */
  reportReplyFailure: (failure: unknown) => void
}>

/** How one model round of a reply ended. */
type ReplyRound =
  | Readonly<{
      /** The model ended the reply. */
      status: "finished"
      /** Supported reason the reply ended. */
      finishReason: ConversationAssistantMessageFinishReason
    }>
  | (ToolCallRound &
      Readonly<{
        /** The model ended the round by calling tools. */
        status: "tool-calls"
      }>)
  | Readonly<{
      /** Cancellation, a newer turn, or a deletion ended the reply. */
      status: "ended"
    }>

/** Round outcome after cancellation, supersession, or deletion. */
const ENDED_REPLY_ROUND = Object.freeze({
  status: "ended"
} satisfies ReplyRound)

/** Context and text placement of one round. */
type ReplyRoundInput = Readonly<{
  /** Context the model answers, in send order. */
  messages: readonly ReplyContextMessage[]
  /** Tools offered in the round; empty when the turn offers none. */
  tools: readonly OpenAIFunctionTool[]
  /** Text stored and sent before the round's first text; empty for none. */
  textPrefix: string
}>

/**
 * Retains one agent's profile and borrowed model access to answer
 * conversation turns as that agent.
 *
 * @remarks Every context the agent builds starts with its own system prompt,
 * never one stored with the conversation. It keeps no state between turns; a
 * turn's rounds and context live only in that turn's `createReply` call, so
 * one instance answers overlapping turns, each through its own
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
   * @param turn - Context, request settings, offered tools, cancellation,
   * reply storage, event and tool call senders, and failure reporters,
   * borrowed until the returned promise settles.
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
   * in later context; failed replies do not. Each failure is reported once,
   * before its final state is stored: to `reportReplyCancellation` when the
   * turn was cancelled or the model reports a cancellation, and to
   * `reportReplyFailure` otherwise. When the turn offers tools, each round
   * that calls tools has its calls answered and the model is asked again;
   * every round's text is stored and sent.
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
   * Runs the model's rounds for one turn until it finishes, storing every
   * text before sending it.
   *
   * @param turn - Turn context, tools, reply storage, and cancellation.
   * @returns The supported finish reason, or undefined after cancellation,
   * supersession, or deletion.
   * @throws If the model fails, a stream ends without ending its round, a
   * delta cannot be stored, or the model calls a tool although none was
   * offered.
   * @remarks A round that ends with tool calls has each call answered, then
   * the model is asked again with the round and its results. A later round's
   * first text starts on a new paragraph when an earlier round stored text.
   */
  async #createReplyText(
    turn: AgentTurn
  ): Promise<ConversationAssistantMessageFinishReason | undefined> {
    const tools = buildAgentToolset(turn.tools)
    const offeredTools = buildOfferedTools(tools)
    let messages = buildAgentContext(
      this.#systemPrompt,
      turn.history,
      turn.userMessageContent
    )
    let hasStoredText = false
    let round = await this.#streamReplyRound(turn, {
      messages,
      tools: offeredTools,
      textPrefix: ""
    })
    while (round.status === "tool-calls") {
      const roundMessages = await handleToolCallRound(
        round,
        tools,
        turn.sendToolCall
      )
      if (roundMessages === undefined) return undefined
      messages = [...messages, ...roundMessages]
      hasStoredText ||= round.text !== ""
      const textPrefix = hasStoredText ? ROUND_TEXT_SEPARATOR : ""
      round = await this.#streamReplyRound(turn, {
        messages,
        tools: offeredTools,
        textPrefix
      })
    }
    return round.status === "finished" ? round.finishReason : undefined
  }

  /**
   * Streams one model round, storing every text before sending it.
   *
   * @param turn - Turn context, reply storage, and cancellation.
   * @param input - The round's context, offered tools, and text prefix.
   * @returns How the round ended: finished, with tool calls and the round's
   * own text, or ended by cancellation, supersession, or deletion.
   * @throws If the model fails, its stream ends without ending the round, or a
   * delta cannot be stored.
   * @remarks Storing and sending happen in one synchronous step, so a
   * follower that reads a snapshot in its own step sees either both or
   * neither. Leaving the stream early releases the model request.
   */
  async #streamReplyRound(
    turn: AgentTurn,
    input: ReplyRoundInput
  ): Promise<ReplyRound> {
    if (turn.abortSignal.aborted) return ENDED_REPLY_ROUND
    const stream = await this.#replyModel.openReplyStream({
      messages: input.messages,
      tools: input.tools,
      model: turn.model,
      generationOptions: turn.generationOptions,
      abortSignal: turn.abortSignal
    })
    let roundText = ""
    for await (const event of stream) {
      if (turn.abortSignal.aborted) return ENDED_REPLY_ROUND
      if (event.type === "finish")
        return { status: "finished", finishReason: event.finishReason }
      if (event.type === "tool-calls")
        return {
          status: "tool-calls",
          text: roundText,
          toolCalls: event.toolCalls
        }
      const delta =
        roundText === "" ? input.textPrefix + event.content : event.content
      if (!turn.updateAssistantMessageContent(delta)) return ENDED_REPLY_ROUND
      turn.sendEvent({ type: "delta", content: delta })
      roundText += event.content
    }
    if (turn.abortSignal.aborted) return ENDED_REPLY_ROUND
    throw new Error("Model stream ended without a finish reason")
  }
}

/**
 * Stores and reports a reply that failed or was cancelled.
 *
 * @param turn - Turn-scoped persistence, failure reporters, cancellation, and
 * sender.
 * @param error - Failure raised while answering.
 * @throws An `AggregateError` holding `error` followed by the persistence
 * failure when the terminal state cannot be stored.
 * @remarks The model reports a cancelled request even when the agent has not
 * yet observed its own abort, so both mean an interrupted reply. Any other
 * failure stores `failed` and sends an `error` event. Both are reported as
 * {@link Agent.createReply} describes.
 */
function handleReplyFailure(turn: AgentTurn, error: unknown): void {
  const isCancelled =
    turn.abortSignal.aborted || error instanceof ChatCompletionCancelledError
  if (isCancelled) {
    turn.reportReplyCancellation(error)
  } else {
    turn.reportReplyFailure(error)
  }
  try {
    turn.updateAssistantMessageState({
      status: isCancelled ? "interrupted" : "failed"
    })
  } catch (persistenceError) {
    throw new AggregateError(
      [error, persistenceError],
      "Chat failure could not be finalized",
      { cause: persistenceError }
    )
  }
  turn.sendEvent(
    isCancelled
      ? { type: "interrupted" }
      : { type: "error", message: "Chat completion failed. Please try again." }
  )
}
