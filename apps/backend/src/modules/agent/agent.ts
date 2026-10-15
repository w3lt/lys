import type {
  ChatGenerationEvent,
  MessageGenerationOptions
} from "@lys/protocol"
import type {
  ConversationAssistantMessageFinishReason,
  ConversationMessage,
  ConversationSource,
  OpenAIFunctionTool,
  ReplyPart,
  ToolCallReplyPart,
  ToolDefinition
} from "@lys/share"
import type { TurnBuiltInTool } from "../tool/builtIn/builtInTool"
import { ChatCompletionCancelledError } from "../../utils/errors"
import { buildAgentContext } from "./agentContext"
import ReplyPartSequence, {
  type ReplyPartDraft,
  type ReplyToolCallChange
} from "./replyPartSequence"
import type { ReplyContextMessage, ReplyModel } from "./replyModel"
import SourceCatalog from "./sourceCatalog"
import {
  buildAgentToolset,
  buildOfferedTools,
  handleToolCallRound,
  type AgentToolset,
  type CreateToolCallGate,
  type SendClientToolCall,
  type ToolCallRound
} from "./toolCallRound"

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
  /**
   * Sources the conversation stored before this turn, each URL once under a
   * distinct number; the turn numbers new sources after them.
   */
  sources: readonly ConversationSource[]
  /** Text of the user message this turn answers. */
  userMessageContent: string
  /** Model selected by the request. */
  model: string
  /** Caller-provided sampling and reply length controls. */
  generationOptions: MessageGenerationOptions
  /** Client tools offered for the turn, each name once; empty when none are. */
  clientTools: readonly ToolDefinition[]
  /**
   * Backend tools found for the turn, each name once and none named like a
   * client tool; empty when none are offered.
   */
  builtInTools: readonly TurnBuiltInTool[]
  /** Generation-owned cancellation, aborted by Stop or shutdown. */
  abortSignal: AbortSignal
  /**
   * Stores a new part after the reply's last one; undefined after deletion,
   * supersession, or finalization.
   */
  createReplyPart: (draft: ReplyPartDraft) => ReplyPart | undefined
  /**
   * Appends a fragment to one of the reply's reasoning or text parts;
   * returns the time stored, or undefined after deletion, supersession, or
   * finalization.
   */
  updateReplyPartContent: (
    partId: string,
    content: string
  ) => string | undefined
  /**
   * Stores one change of one of the reply's tool calls; undefined after
   * deletion, supersession, or finalization, or when the call is not in the
   * state the change follows.
   */
  updateReplyToolCall: (
    toolCallId: string,
    change: ReplyToolCallChange
  ) => ToolCallReplyPart | undefined
  /** Stores the final state; false after deletion or prior finalization. */
  updateAssistantMessageState: (
    completion: AssistantMessageCompletion
  ) => boolean
  /** Queues one event for every stream following the reply; never waits. */
  sendEvent: (event: ChatGenerationEvent) => void
  /**
   * Sends one allowed call of a client tool to every stream following the
   * reply to run and waits for the client's result; resolves with undefined
   * when the reply was stopped or shut down while the call waited. Never
   * rejects.
   */
  sendClientToolCall: SendClientToolCall
  /**
   * Creates the approval gate of one round of tool calls, which asks the
   * person through every stream following the reply unless the tool is
   * saved as Just run. Called once per round, when the round's calls arrive.
   */
  createToolCallGate: CreateToolCallGate
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

/** Context and index of one round. */
type ReplyRoundInput = Readonly<{
  /** Context the model answers, in send order. */
  messages: readonly ReplyContextMessage[]
  /** Zero-based index of the round in the reply. */
  round: number
}>

/** What one reply keeps across its rounds. */
type ReplyRoundState = Readonly<{
  /** Turn context, tools, reply storage, and cancellation. */
  turn: AgentTurn
  /** Tools offered for the turn, by name. */
  tools: AgentToolset
  /** Function tools the model is offered in every round. */
  offeredTools: readonly OpenAIFunctionTool[]
  /** Stores and sends the reply's parts. */
  replyParts: ReplyPartSequence
  /** Numbers the web sources the reply's tool results show. */
  sourceCatalog: SourceCatalog
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
   * Answers one turn, storing each part and fragment before sending it and
   * the final state before the final event.
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
   * after a model failure. Parts stored so far stay stored. Interrupted
   * replies stay in later context; failed replies do not. Each failure is
   * reported once, before its final state is stored: to
   * `reportReplyCancellation` when the turn was cancelled or the model
   * reports a cancellation, and to `reportReplyFailure` otherwise. Each
   * round's reasoning and text are stored and sent as parts of their round.
   * When the turn offers tools, each round that calls tools stores every call
   * and its outcome as a part, has its calls answered, and asks the model
   * again. A client tool's call is answered by the client; a backend tool's
   * call runs here once the client allows it, under the turn's cancellation,
   * numbering the web sources it shows after the conversation's.
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
   * part before sending it.
   *
   * @param turn - Turn context, tools, reply storage, and cancellation.
   * @returns The supported finish reason, or undefined after cancellation,
   * supersession, or deletion.
   * @throws If the model fails, a stream ends without ending its round, a
   * part cannot be stored, the model calls a tool although none was
   * offered, or a backend tool's run fails for a reason other than Stop.
   * @remarks A round that ends with tool calls has each call answered, then
   * the model is asked again with the round and its results, as the next
   * round.
   */
  async #createReplyText(
    turn: AgentTurn
  ): Promise<ConversationAssistantMessageFinishReason | undefined> {
    const tools = buildAgentToolset(turn.clientTools, turn.builtInTools)
    const state: ReplyRoundState = Object.freeze({
      turn,
      tools,
      offeredTools: buildOfferedTools(tools),
      replyParts: new ReplyPartSequence({
        createReplyPart: turn.createReplyPart,
        updateReplyPartContent: turn.updateReplyPartContent,
        updateReplyToolCall: turn.updateReplyToolCall,
        sendEvent: turn.sendEvent
      }),
      sourceCatalog: new SourceCatalog(turn.sources)
    })
    let messages = buildAgentContext(
      this.#systemPrompt,
      turn.history,
      turn.userMessageContent
    )
    let round = await this.#createReplyRound(state, { messages, round: 0 })
    while (round.status === "tool-calls") {
      const roundMessages = await handleToolCallRound(round, {
        tools,
        sendClientToolCall: turn.sendClientToolCall,
        createToolCallGate: turn.createToolCallGate,
        abortSignal: turn.abortSignal,
        replyParts: state.replyParts,
        sourceCatalog: state.sourceCatalog
      })
      if (roundMessages === undefined) return undefined
      messages = [...messages, ...roundMessages]
      round = await this.#createReplyRound(state, {
        messages,
        round: round.round + 1
      })
    }
    return round.status === "finished" ? round.finishReason : undefined
  }

  /**
   * Creates one model round: streams it, storing every reasoning and text
   * fragment as a part of the round before sending it.
   *
   * @param state - The reply's turn, tools, part sequence, and catalog.
   * @param input - The round's context and index.
   * @returns How the round ended: finished, with tool calls and the round's
   * own text, or ended by cancellation, supersession, or deletion.
   * @throws If the model fails, its stream ends without ending the round, or a
   * part cannot be stored.
   * @remarks Storing and sending happen in one synchronous step, so a
   * follower that reads a snapshot in its own step sees either both or
   * neither. Leaving the stream early releases the model request.
   */
  async #createReplyRound(
    state: ReplyRoundState,
    input: ReplyRoundInput
  ): Promise<ReplyRound> {
    const { turn, replyParts } = state
    if (turn.abortSignal.aborted) return ENDED_REPLY_ROUND
    const stream = await this.#replyModel.openReplyStream({
      messages: input.messages,
      tools: state.offeredTools,
      model: turn.model,
      generationOptions: turn.generationOptions,
      abortSignal: turn.abortSignal
    })
    let roundText = ""
    for await (const event of stream) {
      if (turn.abortSignal.aborted) return ENDED_REPLY_ROUND
      switch (event.type) {
        case "finish":
          return { status: "finished", finishReason: event.finishReason }
        case "tool-calls":
          return buildToolCallReplyRound(
            input.round,
            roundText,
            event.toolCalls
          )
        case "reasoning":
          if (!replyParts.updateReplyReasoning(input.round, event.content))
            return ENDED_REPLY_ROUND
          break
        case "text":
          if (!replyParts.updateReplyText(input.round, event.content))
            return ENDED_REPLY_ROUND
          roundText += event.content
      }
    }
    if (turn.abortSignal.aborted) return ENDED_REPLY_ROUND
    throw new Error("Model stream ended without a finish reason")
  }
}

/**
 * Builds the outcome of a round that ended with tool calls.
 *
 * @param round - Zero-based index of the round.
 * @param text - Text the round wrote before its calls.
 * @param toolCalls - Calls in the model's order.
 * @returns The round's tool-call outcome.
 */
function buildToolCallReplyRound(
  round: number,
  text: string,
  toolCalls: ToolCallRound["toolCalls"]
): ReplyRound {
  return { status: "tool-calls", round, text, toolCalls }
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
