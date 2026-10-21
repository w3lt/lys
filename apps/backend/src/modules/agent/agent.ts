import type {
  ChatGenerationEvent,
  MessageGenerationOptions
} from "@lys/protocol"
import type {
  ConversationAssistantMessageFinishReason,
  ConversationMessage,
  ConversationSource,
  ConversationUserMessage,
  OpenAIFunctionTool,
  ReplyPart,
  ToolCallReplyPart,
  ToolDefinition
} from "@lys/share"
import type { TurnBuiltInTool } from "../tool/builtIn/builtInTool"
import { waitForSettlementOrAbort } from "../../utils/abort"
import { ChatCompletionCancelledError } from "../../utils/errors"
import {
  buildAgentContext,
  calculateAgentContextHistoryMessageCount,
  readAgentContextImages,
  UNSEEN_CONTEXT_IMAGES,
  type AgentContextImages,
  type AgentContextUserMessage,
  type FindAttachmentImage
} from "./agentContext"
import {
  findReplyRoundFitFailure,
  ReplyContextOverflowError,
  ReplyModelNotLoadedError
} from "./replyContextFit"
import type {
  ReplyContextMeasurement,
  ReplyContextMeter
} from "./replyContextMeter"
import type {
  ReplyContextMessage,
  ReplyModel,
  ReplyStreamEvent
} from "./replyModel"
import ReplyPartSequence, {
  type ReplyPartDraft,
  type ReplyToolCallChange
} from "./replyPartSequence"
import SourceCatalog from "./sourceCatalog"
import {
  buildAgentToolset,
  buildDefinedToolOffer,
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
  /** Stored user message this turn answers, with its attachments. */
  userMessage: ConversationUserMessage
  /**
   * Whether the model sees images: true sends each image attachment's bytes
   * after its message's text, false a sentence saying the model cannot see
   * it.
   */
  canSeeImages: boolean
  /**
   * Reads the stored bytes of one image attachment of the conversation;
   * borrowed until the reply settles. Not called when the model cannot see
   * images.
   */
  findAttachmentImage: FindAttachmentImage
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
   * saved as Just run. Called once per round that has a call to gate, when
   * the round's calls arrive; a round whose calls all name tools that run
   * without approval creates none.
   */
  createToolCallGate: CreateToolCallGate
  /**
   * Receives the failure that ended a reply cancelled by Stop or shutdown, or
   * reported as cancelled by the model.
   */
  reportReplyCancellation: (failure: unknown) => void
  /**
   * Receives the failure that ended a reply stored as failed because a round
   * was not sent: it did not fit the model's context window, or the model was
   * not loaded. The person is told why through the reply's `error` event.
   */
  reportReplyRefusal: (
    failure: ReplyContextOverflowError | ReplyModelNotLoadedError
  ) => void
  /** Receives any other failure that ended a reply stored as failed. */
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

/** A reasoning or text fragment the model streamed. */
type ReplyFragmentEvent = Extract<
  ReplyStreamEvent,
  { type: "reasoning" | "text" }
>

/** Round outcome after cancellation, supersession, or deletion. */
const ENDED_REPLY_ROUND = Object.freeze({
  status: "ended"
} satisfies ReplyRound)

/** The next message as a context measurement sends it: without text or files. */
const EMPTY_USER_MESSAGE = Object.freeze({
  content: "",
  attachments: []
} satisfies AgentContextUserMessage)

/** What the next message of a conversation would be sent with. */
export type AgentContextInput = Readonly<{
  /** Stored transcript, in conversation order; empty for a new conversation. */
  history: readonly ConversationMessage[]
  /** Identifier of the model the message would be sent to. */
  model: string
  /** Whether that model sees images, as {@link AgentTurn.canSeeImages}. */
  canSeeImages: boolean
  /**
   * Reads one stored image's bytes, as {@link AgentTurn.findAttachmentImage};
   * borrowed until the measurement settles.
   */
  findAttachmentImage: FindAttachmentImage
  /**
   * Definitions of the offered tools, each name once: client tools first,
   * then backend tools; empty when none would be offered.
   */
  tools: readonly ToolDefinition[]
}>

/**
 * How much of the model's context window a conversation takes before its next
 * message's text, in tokens of the model's own tokenizer.
 */
export type AgentContextMeasurement = Readonly<{
  /** Context length the model is loaded with; a positive integer. */
  contextLength: number
  /** Tokens of the agent's system prompt. */
  systemPromptTokens: number
  /** Tokens of the offered tool definitions; 0 when none are offered. */
  toolTokens: number
  /** Tokens of the stored messages a turn would include. */
  historyTokens: number
  /** Number of stored messages a turn would include. */
  historyMessageCount: number
  /**
   * Tokens the next message takes without its text: the chat template's
   * markup around it.
   */
  messageMarkupTokens: number
}>

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
 * Every round's context is measured against the model's window before it is
 * sent, and a round that does not fit, or whose model is not loaded, is never
 * sent. Owns no resource: the model's owner releases it. Concurrency model:
 * reentrant.
 */
export default class Agent {
  /** Code stored on the conversations this agent answers. */
  readonly #code: string
  /** Instructions sent first in every context. */
  readonly #systemPrompt: string
  /** Borrowed model access that writes every reply. */
  readonly #replyModel: ReplyModel
  /** Borrowed meter that measures every context before it is sent. */
  readonly #replyContextMeter: ReplyContextMeter

  /**
   * Creates a ready agent without contacting its model.
   * @param profile - Trusted code and system prompt of the agent.
   * @param replyModel - Model access lent for the agent's lifetime.
   * @param replyContextMeter - Context meter of the same model, lent for the
   * agent's lifetime.
   */
  public constructor(
    profile: AgentProfile,
    replyModel: ReplyModel,
    replyContextMeter: ReplyContextMeter
  ) {
    this.#code = profile.code
    this.#systemPrompt = profile.systemPrompt
    this.#replyModel = replyModel
    this.#replyContextMeter = replyContextMeter
  }

  /**
   * Code of this agent.
   * @returns The valid agent code given at creation; it never changes.
   */
  public get code(): string {
    return this.#code
  }

  /**
   * Finds how much of the model's context window a conversation takes before
   * its next message.
   *
   * @param input - Stored transcript, model, whether it sees images, the
   * image reader, and offered tool definitions, borrowed until the returned
   * promise settles.
   * @returns A promise resolving to the window and the tokens of this agent's
   * system prompt, of the tools, of the stored messages a turn would include,
   * and of the new message's markup, measured exactly as a turn's first round
   * sends them with an empty new message without files; or to undefined when
   * the model is not loaded. The history's images are read first when the
   * model sees images, so their tokens are counted as a turn sends them.
   * @throws The meter's failure when the model's runtime cannot be reached,
   * is busy, or fails; the image reader's failure; and a Zod error for a
   * definition that does not match `toolDefinitionSchema`.
   */
  public async findContextMeasurement(
    input: AgentContextInput
  ): Promise<AgentContextMeasurement | undefined> {
    const images = await readContextImages(
      input.history,
      input.canSeeImages,
      input.findAttachmentImage
    )
    const measurement =
      await this.#replyContextMeter.findReplyContextMeasurement({
        messages: buildAgentContext({
          systemPrompt: this.#systemPrompt,
          history: input.history,
          userMessage: EMPTY_USER_MESSAGE,
          images
        }),
        tools: buildDefinedToolOffer(input.tools),
        model: input.model
      })
    return measurement === undefined
      ? undefined
      : buildAgentContextMeasurement(
          measurement,
          calculateAgentContextHistoryMessageCount(input.history)
        )
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
   * rejection. A part, fragment, call, completion, or interrupted-state write
   * that throws before that point is itself handled as the failure that
   * ended the reply.
   * @remarks When the reply settles without throwing it has sent exactly one
   * final event: `done` after a stored completion; `interrupted` after
   * cancellation, or when a newer turn or a deletion ended the reply; `error`
   * after a model failure. Parts stored so far stay stored. Interrupted
   * replies stay in later context; failed replies do not. Each failure is
   * reported once, before its final state is stored: to
   * `reportReplyCancellation` when the turn was cancelled or the model
   * reports a cancellation, to `reportReplyRefusal` when a round was not sent
   * because it did not fit or its model was not loaded, and to
   * `reportReplyFailure` otherwise. Each round's reasoning and text are stored
   * and sent as parts of their round. When the turn offers tools, each round
   * that calls tools stores every call and its outcome as a part, has its
   * calls answered, and asks the model again. A client tool's call is
   * answered by the client; a backend tool's call runs here once the client
   * allows it, or at once for a tool that runs without approval, under the
   * turn's cancellation, numbering the web sources it shows after the
   * conversation's. When the model sees images, the image attachments of the
   * history and the new message are read from this machine once, before the
   * first round, and sent with their messages in every round. A round whose
   * context, tools, and reply ceiling exceed the model's context length, or
   * whose model is not loaded, is not sent: the reply fails, keeping the
   * parts earlier rounds stored, and its `error` event says why.
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
   * @throws If an image attachment cannot be read although its file is not
   * missing, a round does not fit the model's window or its model is not
   * loaded, the model fails, a stream ends without ending its round, a
   * part cannot be stored, the model calls a tool although none was
   * offered, or a backend tool's run fails for a reason other than Stop; and
   * the turn's abort reason when it is stopped while a round's context is
   * measured.
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
    const images = await readContextImages(
      [...turn.history, turn.userMessage],
      turn.canSeeImages,
      turn.findAttachmentImage
    )
    const messages = buildAgentContext({
      systemPrompt: this.#systemPrompt,
      history: turn.history,
      userMessage: turn.userMessage,
      images
    })
    const round = await this.#createReplyRound(state, { messages, round: 0 })
    return this.#handleReplyRoundEnd(state, messages, round)
  }

  /**
   * Handles the end of one of a reply's rounds: has the round's tool calls
   * answered and asks the model for the next round, until a round finishes
   * the reply or the reply ends.
   *
   * @param state - The reply's turn, tools, part sequence, and catalog.
   * @param messages - Context the ended round answered, in send order.
   * @param round - How that round ended.
   * @returns The supported finish reason, or undefined after cancellation,
   * supersession, or deletion.
   * @throws As {@link Agent.createReply} reports for a round or a call.
   * @remarks Each round needs the results of the round before it, so the
   * rounds run one after another.
   */
  async #handleReplyRoundEnd(
    state: ReplyRoundState,
    messages: readonly ReplyContextMessage[],
    round: ReplyRound
  ): Promise<ConversationAssistantMessageFinishReason | undefined> {
    if (round.status !== "tool-calls")
      return round.status === "finished" ? round.finishReason : undefined
    const { turn } = state
    const roundMessages = await handleToolCallRound(round, {
      tools: state.tools,
      sendClientToolCall: turn.sendClientToolCall,
      createToolCallGate: turn.createToolCallGate,
      abortSignal: turn.abortSignal,
      replyParts: state.replyParts,
      sourceCatalog: state.sourceCatalog
    })
    if (roundMessages === undefined) return undefined
    const nextMessages = [...messages, ...roundMessages]
    const nextRound = await this.#createReplyRound(state, {
      messages: nextMessages,
      round: round.round + 1
    })
    return this.#handleReplyRoundEnd(state, nextMessages, nextRound)
  }

  /**
   * Creates one model round: streams it, storing every reasoning and text
   * fragment as a part of the round before sending it.
   *
   * @param state - The reply's turn, tools, part sequence, and catalog.
   * @param input - The round's context and index.
   * @returns How the round ended: finished, with tool calls and the round's
   * own text, or ended by cancellation, supersession, or deletion.
   * @throws If the round does not fit the model's window or its model is
   * not loaded, the model fails, its stream ends without ending the round, or
   * a part cannot be stored; and the turn's abort reason when it is stopped
   * while the round's context is measured.
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
    const stream = await this.#openReplyRoundStream(state, input)
    let roundText = ""
    for await (const event of stream) {
      if (turn.abortSignal.aborted) return ENDED_REPLY_ROUND
      if (event.type === "finish")
        return { status: "finished", finishReason: event.finishReason }
      if (event.type === "tool-calls")
        return buildToolCallReplyRound(input.round, roundText, event.toolCalls)
      if (!updateReplyFragment(replyParts, input.round, event))
        return ENDED_REPLY_ROUND
      if (event.type === "text") roundText += event.content
    }
    if (turn.abortSignal.aborted) return ENDED_REPLY_ROUND
    throw new Error("Model stream ended without a finish reason")
  }

  /**
   * Opens one round's reply stream once its context is measured to fit.
   *
   * @param state - The reply's turn, with its model, generation controls, and
   * cancellation, and the tools offered in every round.
   * @param input - The round's context.
   * @returns The model's events for the round.
   * @throws A `ReplyModelNotLoadedError` when the model is not loaded, a
   * `ReplyContextOverflowError` when the context, tools, and reply ceiling
   * exceed its context length, the meter's failure, or the model's failure
   * to open the stream; and the turn's abort reason when it is stopped
   * while the measurement is pending. Nothing is sent to the model before the
   * context is known to fit.
   * @remarks Stop ends the wait for the measurement at once. A measurement
   * the meter already accepted keeps running under the meter's ownership,
   * and its outcome is ignored.
   */
  async #openReplyRoundStream(
    state: ReplyRoundState,
    input: ReplyRoundInput
  ): Promise<AsyncIterable<ReplyStreamEvent>> {
    const { turn, offeredTools } = state
    const measurement = await waitForSettlementOrAbort(
      this.#replyContextMeter.findReplyContextMeasurement({
        messages: input.messages,
        tools: offeredTools,
        model: turn.model
      }),
      turn.abortSignal
    )
    const fitFailure = findReplyRoundFitFailure({
      measurement,
      model: turn.model,
      reserveTokens: turn.generationOptions.replyCeiling ?? 0
    })
    if (fitFailure !== undefined) throw fitFailure
    return await this.#replyModel.openReplyStream({
      messages: input.messages,
      tools: offeredTools,
      model: turn.model,
      generationOptions: turn.generationOptions,
      abortSignal: turn.abortSignal
    })
  }
}

/**
 * Reads the images a context sends, for the model that answers it.
 *
 * @param messages - Stored messages the context is built from, in
 * conversation order.
 * @param canSeeImages - Whether the model sees images.
 * @param findAttachmentImage - Reads one image's bytes; borrowed until the
 * returned promise settles.
 * @returns A promise resolving to {@link UNSEEN_CONTEXT_IMAGES} for a model
 * without vision, without reading any file; otherwise to the images as
 * {@link readAgentContextImages} read them.
 * @throws The reader's failure, for a file that cannot be read although it
 * is not missing.
 */
async function readContextImages(
  messages: readonly ConversationMessage[],
  canSeeImages: boolean,
  findAttachmentImage: FindAttachmentImage
): Promise<AgentContextImages> {
  return canSeeImages
    ? await readAgentContextImages(messages, findAttachmentImage)
    : UNSEEN_CONTEXT_IMAGES
}

/**
 * Builds the conversation measurement from a measured context.
 *
 * @param measurement - Measurement of the system prompt, the included
 * history, and an empty new message, with the offered tools.
 * @param historyMessageCount - Number of stored messages the history's
 * context messages come from; a reply's rounds and tool results count as one.
 * @returns The window, the system prompt's, tools', history's, and new
 * message markup's tokens, and the stored message count.
 * @throws If the measurement holds fewer than two counts, which breaks the
 * meter's one-count-per-message contract.
 */
function buildAgentContextMeasurement(
  measurement: ReplyContextMeasurement,
  historyMessageCount: number
): AgentContextMeasurement {
  const [systemPromptTokens, ...laterTokenCounts] =
    measurement.messageTokenCounts
  const messageMarkupTokens = laterTokenCounts.at(-1)
  if (systemPromptTokens === undefined || messageMarkupTokens === undefined)
    throw new Error("The context measurement lacks a message's count")
  const historyTokenCounts = laterTokenCounts.slice(0, -1)
  return Object.freeze({
    contextLength: measurement.contextLength,
    systemPromptTokens,
    toolTokens: measurement.toolTokenCount,
    historyTokens: historyTokenCounts.reduce(
      (total, messageTokens) => total + messageTokens,
      0
    ),
    historyMessageCount,
    messageMarkupTokens
  })
}

/**
 * Stores and sends one reasoning or text fragment as a part of its round.
 *
 * @param replyParts - The reply's part sequence.
 * @param round - Zero-based index of the fragment's round.
 * @param event - The fragment the model streamed.
 * @returns True once stored and sent; false when the reply refused it.
 */
function updateReplyFragment(
  replyParts: ReplyPartSequence,
  round: number,
  event: ReplyFragmentEvent
): boolean {
  return event.type === "reasoning"
    ? replyParts.updateReplyReasoning(round, event.content)
    : replyParts.updateReplyText(round, event.content)
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
 * failure stores `failed` and sends an `error` event whose sentence says why
 * when the round did not fit or its model is not loaded. Both are reported as
 * {@link Agent.createReply} describes.
 */
function handleReplyFailure(turn: AgentTurn, error: unknown): void {
  const isCancelled =
    turn.abortSignal.aborted || error instanceof ChatCompletionCancelledError
  if (isCancelled) {
    turn.reportReplyCancellation(error)
  } else if (
    error instanceof ReplyContextOverflowError ||
    error instanceof ReplyModelNotLoadedError
  ) {
    turn.reportReplyRefusal(error)
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
      : { type: "error", message: formatReplyFailureMessage(error) }
  )
}

/**
 * Formats the sentence followers are sent when a reply fails.
 *
 * @param failure - Failure that ended the reply.
 * @returns For a round that did not fit, what it needed and the window, with
 * the next steps; for a model that is not loaded, how to load it; otherwise
 * the general sentence. No upstream or internal text is included.
 */
function formatReplyFailureMessage(failure: unknown): string {
  if (failure instanceof ReplyContextOverflowError) {
    return `The conversation no longer fits the model's context window: the next request to the model needs ${formatTokenCount(failure.requiredTokens)} tokens, including the room kept for the reply, and the model is loaded with ${formatTokenCount(failure.contextLength)}. Start a new conversation, or load the model with a longer context in Settings → Model.`
  }
  if (failure instanceof ReplyModelNotLoadedError) {
    return "The model is not loaded, so Lys cannot check that the conversation fits it. Load the model in Settings → Model, then try again."
  }
  return "Chat completion failed. Please try again."
}

/**
 * Formats a token count for a sentence.
 *
 * @param tokenCount - Whole number of tokens.
 * @returns The count with comma thousands separators, such as `8,192`.
 */
function formatTokenCount(tokenCount: number): string {
  return tokenCount.toLocaleString("en-US")
}
