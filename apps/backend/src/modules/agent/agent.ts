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
import type { TurnMcpTool } from "../mcp/mcpServerRegistry"
import type { TurnBuiltInTool } from "../tool/builtIn/builtInTool"
import { waitForSettlementOrAbort } from "../../utils/abort"
import { ChatCompletionCancelledError } from "../../utils/errors"
import AgentActivity, {
  AgentRequestLimitError,
  type AgentRequestLimits,
  type AgentRequestStart,
  type AgentRequestState
} from "./agentActivity"
import {
  buildAgentContext,
  calculateAgentContextHistoryMessageCount,
  formatSystemPrompt,
  getAgentContextImageSides,
  readAgentContextImages,
  UNSEEN_CONTEXT_IMAGES,
  type AgentContextImages,
  type AgentContextUserMessage,
  type FindAttachmentImage,
  type GetAttachmentImageFileStatus
} from "./agentContext"
import type { AgentIdentity, AgentRole } from "./agentRoles"
import {
  buildAgentStateDefinitions,
  buildAgentStateTools,
  type AgentStateReader
} from "./agentStateTools"
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
  ReplyContextImageSides,
  ReplyContextMessage,
  ReplyModel,
  ReplyStreamEvent
} from "./replyModel"
import ReplyPartSequence, {
  type ReplyPartDraft,
  type ReplyPartSequenceDependencies,
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
import type { UnofferedTools } from "./unofferedTools"

/** What an agent knows about itself to answer turns. */
export type AgentProfile = Readonly<{
  /**
   * Valid agent code, stored on every conversation the agent starts and
   * compared exactly when a turn looks its agent up.
   */
  code: string
  /** Role that decides which agents' state the agent may read. */
  role: AgentRole
  /**
   * Non-empty instructions sent first in every context the agent builds,
   * until {@link Agent.updateSystemPrompt} replaces them.
   */
  systemPrompt: string
  /**
   * How many of the agent's replies are written at once, and how many may
   * wait for a free request slot; fixed for the agent's lifetime.
   */
  requestLimits: AgentRequestLimits
}>

/** What an agent borrows for its lifetime. */
export type AgentDependencies = Readonly<{
  /** Model access that writes every reply. */
  replyModel: ReplyModel
  /** Context meter of the same model, which measures every context. */
  replyContextMeter: ReplyContextMeter
  /** Reads agents and their state for the agent's state tools. */
  stateReader: AgentStateReader
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
  /** UUIDv7 of the conversation the turn belongs to. */
  conversationId: string
  /**
   * UUIDv7 of the stored reply the turn writes, which identifies the request
   * in the agent's activity.
   */
  requestId: string
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
  /**
   * Whether the model is trained for tool use: true offers the agent's state
   * tools after the turn's built-in and MCP tools, also while tool calls are
   * off.
   */
  trainedForToolUse: boolean
  /** Caller-provided sampling and reply length controls. */
  generationOptions: MessageGenerationOptions
  /** Client tools offered for the turn, each name once; empty when none are. */
  clientTools: readonly ToolDefinition[]
  /**
   * Backend tools found for the turn, each name once and none named like a
   * client tool; empty when none are offered.
   */
  builtInTools: readonly TurnBuiltInTool[]
  /**
   * MCP tools found for the turn, each name once and none named like
   * another offered tool; empty when none are offered. Each call asks the
   * person first, unless they saved the tool as Just run.
   */
  mcpTools: readonly TurnMcpTool[]
  /**
   * What the request names about the tools the turn does not offer: that
   * tool calls are off, or the switched-off tools and the switched-on
   * backend tools that cannot run now, none of them offered. Every round's
   * instructions end with the notes about them, and a call of one is
   * answered as not run without asking or running it.
   */
  unofferedTools: UnofferedTools
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
   * was not sent: it did not fit the model's context window, the model was
   * not loaded, or every request slot of the agent was held and its line of
   * waiting replies was full. The person is told why through the reply's
   * `error` event.
   */
  reportReplyRefusal: (
    failure:
      | ReplyContextOverflowError
      | ReplyModelNotLoadedError
      | AgentRequestLimitError
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

/** State tools of a turn whose model is not trained for tool use. */
const NO_AGENT_STATE_TOOLS: readonly TurnBuiltInTool[] = Object.freeze([])

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
   * Finds whether one stored image's file is on this machine, without
   * reading it; borrowed until the measurement settles. Not called when the
   * model cannot see images.
   */
  getAttachmentImageFileStatus: GetAttachmentImageFileStatus
  /**
   * Definitions of the offered tools, each name once: client tools first,
   * then built-in tools, then MCP tools; empty when none would be offered.
   */
  tools: readonly ToolDefinition[]
  /**
   * Whether that model is trained for tool use, as
   * {@link AgentTurn.trainedForToolUse}: true counts the agent's state tool
   * definitions after `tools`.
   */
  trainedForToolUse: boolean
  /**
   * What the request names about the tools the message would not offer, as
   * {@link AgentTurn.unofferedTools}.
   */
  unofferedTools: UnofferedTools
}>

/**
 * How much of the model's context window a conversation takes before its next
 * message's text, in tokens of the model's own tokenizer.
 */
export type AgentContextMeasurement = Readonly<{
  /** Context length the model is loaded with; a positive integer. */
  contextLength: number
  /**
   * Tokens of the agent's system prompt, with the notes about the tools the
   * message would not offer when there are any.
   */
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
  /** What the request names about the tools the turn does not offer. */
  unofferedTools: UnofferedTools
  /** Function tools the model is offered in every round. */
  offeredTools: readonly OpenAIFunctionTool[]
  /** Stores and sends the reply's parts. */
  replyParts: ReplyPartSequence
  /** Numbers the web sources the reply's tool results show. */
  sourceCatalog: SourceCatalog
}>

/**
 * One live agent: its profile, borrowed model access, and the requests it is
 * working on, answering conversation turns as that agent.
 *
 * @remarks Long-lived: its owner keeps one instance per agent and answers
 * every turn of that agent with it. Every context a turn builds starts with
 * the system prompt the agent held when the turn started, never one stored
 * with the conversation, followed by the notes about the tools the turn does
 * not offer when there are any. Between turns it keeps only that prompt and
 * its activity: each request is listed from the start of its `createReply`
 * call until the call settles, as waiting while it waits for a request slot
 * and then at the step its stored parts show. A turn's rounds and context
 * live only in that turn's `createReply` call, so one instance answers
 * overlapping turns, each through its own {@link AgentTurn}: as many at once
 * as it has request slots, the others waiting in line for one, as long as
 * the model access permits overlapping streams.
 * Every round's context is measured against the model's window before it is
 * sent, and a round that does not fit, or whose model is not loaded, is never
 * sent. Owns no resource: the model's owner releases it. Concurrency model:
 * reentrant; the prompt and the activity change synchronously on the
 * backend's event loop.
 */
export default class Agent {
  /** Code and role of this agent. */
  readonly #identity: AgentIdentity
  /** Instructions sent first in every context a new turn builds. */
  #systemPrompt: string
  /** Borrowed model access that writes every reply. */
  readonly #replyModel: ReplyModel
  /** Borrowed meter that measures every context before it is sent. */
  readonly #replyContextMeter: ReplyContextMeter
  /** Borrowed reader of agents and their state, for the state tools. */
  readonly #stateReader: AgentStateReader
  /**
   * Requests this agent is working on, the step each is at, and its request
   * slots.
   */
  readonly #activity: AgentActivity

  /**
   * Creates a ready agent, working on no request, with every request slot
   * free, without contacting its model.
   * @param profile - Trusted code, role, system prompt, and request limits
   * of the agent.
   * @param dependencies - Model access, its context meter, and the state
   * reader, lent for the agent's lifetime.
   */
  public constructor(profile: AgentProfile, dependencies: AgentDependencies) {
    this.#identity = Object.freeze({ code: profile.code, role: profile.role })
    this.#systemPrompt = profile.systemPrompt
    this.#activity = new AgentActivity(profile.requestLimits)
    this.#replyModel = dependencies.replyModel
    this.#replyContextMeter = dependencies.replyContextMeter
    this.#stateReader = dependencies.stateReader
  }

  /**
   * Code of this agent.
   * @returns The valid agent code given at creation; it never changes.
   */
  public get code(): string {
    return this.#identity.code
  }

  /**
   * Replaces the instructions the agent sends first.
   * @param systemPrompt - Non-empty instructions of the agent as stored now.
   * @remarks A turn already answering keeps the instructions it started
   * with; a turn or a measurement that starts after the call sends the new
   * ones.
   */
  public updateSystemPrompt(systemPrompt: string): void {
    this.#systemPrompt = systemPrompt
  }

  /**
   * Lists the requests the agent is working on, the ones waiting for a
   * request slot included.
   * @returns A frozen list in start order, each request with its step, so
   * the replies that hold slots come before the waiting ones, in line order;
   * later changes leave it as it was.
   */
  public listRequests(): readonly AgentRequestState[] {
    return this.#activity.listRequests()
  }

  /**
   * Finds how much of the model's context window a conversation takes before
   * its next message.
   *
   * @param input - Stored transcript, model, whether it sees images, the
   * image file lookup, offered tool definitions, whether the model is trained
   * for tool use, and what the request names about the tools it would not
   * offer, borrowed until the returned promise settles.
   * @returns A promise resolving to the window and the tokens of this agent's
   * system prompt with the notes about the tools the message would not
   * offer, of the tools with the agent's state tools after them when the
   * model is trained for tool use, of the stored messages a turn would include,
   * and of the new message's markup, measured exactly as a turn's first round
   * sends them with an empty new message without files; or to undefined when
   * the model is not loaded. When the model sees images, the history's image
   * files are looked up first without reading them, so a stored image counts
   * the tokens of its sides and a missing one its placeholder, as a turn
   * sends them. A measurement is not a request: it takes no request slot
   * and is not listed, so it runs at once while every slot is held.
   * @throws The meter's failure when the model's runtime cannot be reached,
   * is busy, or fails; the image file lookup's failure; and a Zod error for a
   * definition that does not match `toolDefinitionSchema`.
   */
  public async findContextMeasurement(
    input: AgentContextInput
  ): Promise<AgentContextMeasurement | undefined> {
    const systemPrompt = this.#systemPrompt
    const images: AgentContextImages<ReplyContextImageSides> =
      input.canSeeImages
        ? await getAgentContextImageSides(
            input.history,
            input.getAttachmentImageFileStatus
          )
        : UNSEEN_CONTEXT_IMAGES
    const measurement =
      await this.#replyContextMeter.findReplyContextMeasurement({
        messages: buildAgentContext({
          systemPrompt: formatSystemPrompt(systemPrompt, input.unofferedTools),
          history: input.history,
          userMessage: EMPTY_USER_MESSAGE,
          images
        }),
        tools: buildDefinedToolOffer(
          input.trainedForToolUse
            ? [
                ...input.tools,
                ...buildAgentStateDefinitions(this.#identity.role)
              ]
            : input.tools
        ),
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
   * because it did not fit, its model was not loaded, or the agent's request
   * slots and line were full, and to `reportReplyFailure` otherwise. Each
   * round's reasoning and text are stored
   * and sent as parts of their round. When the turn offers tools, each round
   * that calls tools stores every call and its outcome as a part, has its
   * calls answered, and asks the model again; a call of a tool the turn
   * does not offer because the request names it, or of any tool not offered
   * while tool calls are off, is stored as failed with a result saying why
   * it did not run, and never runs. A client tool's call is
   * answered by the client; a backend tool's call runs here once the client
   * allows it, or at once for a tool that runs without approval, under the
   * turn's cancellation, numbering the web sources it shows after the
   * conversation's. When the model sees images, the image attachments of the
   * history and the new message are read from this machine once, before the
   * first round, and sent with their messages in every round. A round whose
   * context, tools, and reply ceiling exceed the model's context length, or
   * whose model is not loaded, is not sent: the reply fails, keeping the
   * parts earlier rounds stored, and its `error` event says why. The turn uses
   * the system prompt the agent holds when the call starts. When the model is
   * trained for tool use, the agent's state tools are offered after the
   * turn's built-in and MCP tools, also while tool calls are off, and their
   * calls run at once. The reply holds one of the agent's request slots from
   * the call's start to its end, also while it waits on the person. When
   * every slot is held, it waits in line for one, first come first served,
   * and starts once a slot frees; Stop or shutdown while it waits ends it as
   * cancelled before anything is read or sent. When every slot is held and
   * the line is full, the reply is refused: stored as failed without
   * reaching the model, with an `error` event that says why. The request is
   * listed in the agent's activity from the call's start, preparing round 0,
   * or waiting while it waits for a slot, until the returned promise
   * settles, whatever the outcome; a refused reply is never listed. Each
   * round's start shows it preparing that round, and each part or tool call
   * change the reply stores shows the step it puts the request at. A reply
   * that a newer turn of its conversation supersedes, or whose conversation
   * is deleted, settles only once its next write is refused, so one waiting
   * on an approval, a tool result, or a request slot stays listed until the
   * call is answered or a slot frees for it, the reply is stopped, or the
   * backend stops.
   */
  public async createReply(turn: AgentTurn): Promise<void> {
    const systemPrompt = this.#systemPrompt
    const start = buildRequestStart(turn, new Date())
    try {
      const offer = await this.#activity.offerRequest(start, turn.abortSignal)
      if (offer.status === "refused")
        throw new AgentRequestLimitError(offer.limits)
      const finishReason = await this.#createReplyText(turn, systemPrompt)
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
    } finally {
      this.#activity.removeRequest(start)
    }
  }

  /**
   * Runs the model's rounds for one turn until it finishes, storing every
   * part before sending it.
   *
   * @param turn - Turn context, tools, reply storage, and cancellation.
   * @param systemPrompt - Instructions the turn sends first.
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
    turn: AgentTurn,
    systemPrompt: string
  ): Promise<ConversationAssistantMessageFinishReason | undefined> {
    const tools = buildAgentToolset({
      clientTools: turn.clientTools,
      builtInTools: turn.builtInTools,
      mcpTools: turn.mcpTools,
      agentStateTools: turn.trainedForToolUse
        ? buildAgentStateTools({
            self: this.#identity,
            requestId: turn.requestId,
            reader: this.#stateReader
          })
        : NO_AGENT_STATE_TOOLS
    })
    const state: ReplyRoundState = Object.freeze({
      turn,
      tools,
      unofferedTools: turn.unofferedTools,
      offeredTools: buildOfferedTools(tools),
      replyParts: new ReplyPartSequence(
        buildActivityReplyStorage(turn, this.#activity)
      ),
      sourceCatalog: new SourceCatalog(turn.sources)
    })
    const images = await readContextImages(
      [...turn.history, turn.userMessage],
      turn.canSeeImages,
      turn.findAttachmentImage
    )
    const messages = buildAgentContext({
      systemPrompt: formatSystemPrompt(systemPrompt, turn.unofferedTools),
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
      unofferedTools: state.unofferedTools,
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
    this.#activity.updateRequestRound(turn.requestId, input.round)
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
 * Builds what the agent's activity follows of a request when it starts.
 *
 * @param turn - The turn the request answers.
 * @param now - Time the request started.
 * @returns The request's reply, conversation, model, start time, and the
 * names of the client tools the turn offers.
 */
function buildRequestStart(turn: AgentTurn, now: Date): AgentRequestStart {
  return Object.freeze({
    requestId: turn.requestId,
    conversationId: turn.conversationId,
    model: turn.model,
    startedAt: now.toISOString(),
    clientToolNames: new Set(turn.clientTools.map((tool) => tool.name))
  })
}

/**
 * Shows a part or a tool call change the reply stored in the agent's
 * activity.
 *
 * @param activity - The agent's activity.
 * @param requestId - Reply id of the request.
 * @param part - What the reply's storage returned: the stored part, or
 * undefined when the reply refused the write.
 * @returns The same value, after the activity shows the step a stored part
 * puts the request at; a refused write changes nothing.
 */
function updateActivityStep<Part extends ReplyPart>(
  activity: AgentActivity,
  requestId: string,
  part: Part | undefined
): Part | undefined {
  if (part !== undefined) activity.updateRequestStep(requestId, part)
  return part
}

/**
 * Builds the reply storage of one turn's part sequence, which shows each
 * stored part and tool call change in the agent's activity.
 *
 * @param turn - The turn's reply storage and event sender.
 * @param activity - The agent's activity.
 * @returns The turn's writers and sender; part and tool call writes return
 * what the turn's own writers return.
 */
function buildActivityReplyStorage(
  turn: AgentTurn,
  activity: AgentActivity
): ReplyPartSequenceDependencies {
  return Object.freeze({
    createReplyPart: (draft: ReplyPartDraft) =>
      updateActivityStep(activity, turn.requestId, turn.createReplyPart(draft)),
    updateReplyPartContent: turn.updateReplyPartContent,
    updateReplyToolCall: (toolCallId: string, change: ReplyToolCallChange) =>
      updateActivityStep(
        activity,
        turn.requestId,
        turn.updateReplyToolCall(toolCallId, change)
      ),
    sendEvent: turn.sendEvent
  })
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
    error instanceof ReplyModelNotLoadedError ||
    error instanceof AgentRequestLimitError
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
 * the next steps; for a model that is not loaded, how to load it; for an
 * agent whose request slots and line were full, how many replies it had and
 * when to send again; otherwise the general sentence. No upstream or
 * internal text is included.
 */
function formatReplyFailureMessage(failure: unknown): string {
  if (failure instanceof ReplyContextOverflowError) {
    return `The conversation no longer fits the model's context window: the next request to the model needs ${formatTokenCount(failure.requiredTokens)} tokens, including the room kept for the reply, and the model is loaded with ${formatTokenCount(failure.contextLength)}. Start a new conversation, or load the model with a longer context in Settings → Model.`
  }
  if (failure instanceof ReplyModelNotLoadedError) {
    return "The model is not loaded, so Lys cannot check that the conversation fits it. Load the model in Settings → Model, then try again."
  }
  if (failure instanceof AgentRequestLimitError) {
    return formatRequestLimitMessage(failure.limits)
  }
  return "Chat completion failed. Please try again."
}

/**
 * Formats the sentence followers are sent when a reply's agent had every
 * request slot held and its line of waiting replies full.
 *
 * @param limits - The agent's request limits, all of them reached.
 * @returns How many requests the agent was working on and how many were
 * waiting, and that the message can be sent again once one finishes.
 */
function formatRequestLimitMessage(limits: AgentRequestLimits): string {
  const working =
    limits.slotCount === 1 ? "1 request" : `${limits.slotCount} requests`
  const waiting =
    limits.waitingLimit === 0
      ? ""
      : `, and ${limits.waitingLimit} more ${limits.waitingLimit === 1 ? "is" : "are"} waiting for it`
  return `This agent is already working on ${working}${waiting}, so it did not take this message. Send it again once it finishes one.`
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
