import type {
  ChatGenerationEvent,
  MessageGenerationOptions
} from "@lys/protocol"
import type {
  Conversation,
  ConversationAssistantMessageStatus,
  ToolDefinition
} from "@lys/share"
import type { FastifyBaseLogger } from "fastify"
import type Agent from "../agent/agent"
import type { AgentTurn } from "../agent/agent"
import { AgentRequestLimitError } from "../agent/agentActivity"
import type { FindAttachmentImage } from "../agent/agentContext"
import type { TurnDelegation } from "../agent/turnDelegation"
import type { UnofferedTools } from "../agent/unofferedTools"
import type AttachmentFileStore from "../attachment/attachmentFileStore"
import { buildAttachmentImageReader } from "../attachment/attachmentImageReader"
import ReadAttachmentTool, {
  buildReadAttachmentDefinition,
  hasReadableTextAttachment,
  listReadableAttachments,
  type ReadableAttachment,
  type ReadAttachmentFile
} from "../attachment/readAttachmentTool"
import type { TurnMcpTool } from "../mcp/mcpServerRegistry"
import type { TurnBuiltInTool } from "../tool/builtIn/builtInTool"
import type ToolApprovalService from "../toolApproval/toolApprovalService"
import type { TitleGenerationOptions } from "./chatService"
import type {
  ConversationTurn,
  ConversationTurnWriter,
  GeneratedConversationTitleWriter,
  ReplyPartWriter
} from "./persistence"
import type ReplyGeneration from "./replyGeneration"
import type {
  ReplyGenerationTaskContext,
  ReplyTaskContext
} from "./replyGeneration"
import type ReplyGenerationRegistry from "./replyGenerationRegistry"
import type { ReplyTarget } from "./replyGenerationRegistry"
import createTitleGenerationTask from "./titleGenerationTask"

/**
 * What a turn's reply is written with: its model, the model's controls, and
 * the tools the turn offers. One settings object can start any number of
 * turns; nothing in it belongs to one turn.
 */
export type TurnSettings = Readonly<{
  /** Model that writes the reply. */
  model: string
  /** Sampling and reply length controls sent with every round. */
  generationOptions: MessageGenerationOptions
  /** Client tools the turn offers, each name once; empty when it offers none. */
  clientTools: readonly ToolDefinition[]
  /**
   * Backend tools the turn offers, each name once, without the attachment
   * reader, which the start adds for each turn that offers it; empty when
   * none.
   */
  builtInTools: readonly TurnBuiltInTool[]
  /**
   * MCP tools the turn offers, each name once; each call runs on its server
   * as connected when the call runs. Empty when none.
   */
  mcpTools: readonly TurnMcpTool[]
  /**
   * Whether the turn's tool offer names `delegate_work`. The tool is not
   * among the tools above: the agent adds it itself to a turn that may
   * delegate.
   */
  offersDelegateWork: boolean
  /** What is named about the tools the turn does not offer. */
  unofferedTools: UnofferedTools
  /** Whether the model sees images. */
  canSeeImages: boolean
  /**
   * Whether the model is trained for tool use, so the turn offers the
   * attachment reader and the agent adds its state tools to the turn.
   */
  trainedForToolUse: boolean
}>

/**
 * Who starts a turn: `person` for a chat request, `backend` for a turn the
 * backend starts by itself, such as a job message or a wake-up.
 */
export type TurnStarter = "person" | "backend"

/** A turn that is starting, as the hooks of its starter are told about it. */
export type TurnDelegationContext = Readonly<{
  /** Stored turn and the snapshot of its conversation before it. */
  turn: ConversationTurn
  /** Model, controls, and tools the turn's reply is written with. */
  settings: TurnSettings
  /** Who starts the turn. */
  startedBy: TurnStarter
}>

/** A reply that ended, as the hooks of its turn's starter are told about it. */
export type EndedReply = Readonly<{
  /** UUIDv7 of the conversation that holds the reply. */
  conversationId: string
  /** UUIDv7 of the reply. */
  assistantMessageId: string
  /** Sentence of the reply's `error` event; undefined when it sent none. */
  errorMessage: string | undefined
}>

/** What the starter of a turn supplies so the turn takes part in delegation. */
export type TurnDelegationHooks = Readonly<{
  /**
   * Called once per turn, before its delegation is created. A throw keeps
   * the turn's generation from starting: its delegation is not created, and
   * {@link startTurn} throws the failure.
   */
  handleTurnStarted: (context: TurnDelegationContext) => void
  /**
   * Called once per turn, before its reply task starts. The turn's agent is
   * handed the returned delegation unchanged. A throw keeps the turn's
   * generation from starting, and {@link startTurn} throws the failure.
   */
  createTurnDelegation: (context: TurnDelegationContext) => TurnDelegation
  /**
   * Called once per reply, after its final state is stored, also when its
   * generation could not start, which stores the reply as `interrupted`. For
   * a started generation the call is made inside the reply task, so
   * `stopReply` of the generation resolves only after the hook returned; for
   * one that could not start, it is made before {@link startTurn} throws.
   * When the final state could not be stored, the hook is called all the
   * same, and the reply is still stored as `streaming`. A throw is logged as
   * an error with the turn's logger and changes nothing else.
   */
  handleReplyEnded: (reply: EndedReply) => void
}>

/** One stored turn to start, with who answers it and what with. */
export type StartTurnOptions = Readonly<{
  /** Stored turn and the snapshot of its conversation before it. */
  turn: ConversationTurn
  /** Agent that answers the turn. */
  agent: Agent
  /** Model, controls, and tools the reply is written with. */
  settings: TurnSettings
  /**
   * Who starts the turn. A backend-started turn gets no title task, whatever
   * its conversation's title.
   */
  startedBy: TurnStarter
  /**
   * Hooks of whoever starts the turn, through which the turn takes part in
   * delegation; called as {@link TurnDelegationHooks} describes.
   */
  delegation: TurnDelegationHooks
  /** Logger the turn's tasks log to, kept until the generation settles. */
  logger: FastifyBaseLogger
}>

/**
 * What starting turns borrows from the composition root, for as long as
 * turns are started and their generations run.
 */
export type TurnStartDependencies = Readonly<{
  /** Registry that owns every started generation; not disposed here. */
  generations: Pick<ReplyGenerationRegistry, "startReplyGeneration">
  /** Turn persistence whose lifetime outlives all active generations. */
  turns: Pick<ConversationTurnWriter, "updateAssistantMessageState">
  /** Reply-part persistence whose lifetime outlives all active generations. */
  replyParts: ReplyPartWriter
  /** Conditional generated-title persistence. */
  titleWriter: GeneratedConversationTitleWriter
  /**
   * Stored conversation with its messages; undefined means it is not
   * stored.
   */
  findConversation: (conversationId: string) => Conversation | undefined
  /** Reads stored attachment files, for the attachment reader and for images. */
  attachmentFiles: Pick<AttachmentFileStore, "readAttachment">
  /** Bound title operation retained separately from chat completion. */
  generateTitle: (options: TitleGenerationOptions) => Promise<string>
  /**
   * Context length a model is loaded with, observed through the
   * model-operation queue without loading it; undefined when it is not
   * loaded.
   */
  findLoadedContextLength: (model: string) => Promise<number | undefined>
  /** Inclusive maximum number of title requests permitted for one turn. */
  titleGenerationMaxAttempts: number
  /**
   * Approval gateway every tool call passes, except a call of a backend
   * tool that runs without approval.
   */
  toolApprovals: Pick<ToolApprovalService, "createToolCallGate">
}>

/**
 * Starts the generation of one stored turn; bound to its dependencies by the
 * composition root.
 *
 * @param options - The stored turn, its agent, its settings, who starts it,
 * the starter's delegation hooks, and the logger its tasks log to.
 * @returns The registered generation, as {@link startTurn} returns it.
 * @throws As {@link startTurn} does.
 */
export type StartTurn = (options: StartTurnOptions) => ReplyGeneration

/** What a started turn's reply task keeps until the reply is final. */
type TurnReplyInput = Readonly<{
  /**
   * The stored turn, its agent, its settings, its starter's hooks, and its
   * logger.
   */
  options: StartTurnOptions
  /**
   * Backend tools of the turn, each name once: the settings' tools, then the
   * attachment reader when the turn offers it; empty when none.
   */
  builtInTools: readonly TurnBuiltInTool[]
  /** Reads the bytes of one stored image attachment of the conversation. */
  findAttachmentImage: FindAttachmentImage
  /** The turn's part in delegation, as its starter's hooks created it. */
  turnDelegation: TurnDelegation
}>

/** What a turn's reply task borrows until the reply is final. */
type TurnReplyDependencies = Pick<
  TurnStartDependencies,
  "turns" | "replyParts" | "findConversation" | "toolApprovals"
>

/** How an agent's turn stores its reply and reads the reply's state back. */
type ReplyStorage = Pick<
  AgentTurn,
  | "createReplyPart"
  | "updateReplyPartContent"
  | "updateReplyToolCall"
  | "updateAssistantMessageState"
  | "findReplyStatus"
>

/** The failure that ended a reply because one of its rounds was not sent. */
type ReplyRefusal = Parameters<AgentTurn["reportReplyRefusal"]>[0]

/**
 * Starts the generation that writes one stored turn's reply and, for a
 * person's turn in an untitled conversation, its title unless another turn of
 * that conversation is already generating one.
 *
 * @param dependencies - Registry, persistence, attachment files, title
 * generation, and approval gateway, borrowed until the generation settles.
 * @param options - The stored turn, its agent, its settings, who starts it,
 * the starter's delegation hooks, and the logger its tasks log to.
 * @returns The registered generation. Open its first followers before
 * awaiting anything, so they receive every task event.
 * @throws If the registry no longer admits generations, or the starter's
 * `handleTurnStarted` or `createTurnDelegation` throws; the stored reply is
 * finalized as interrupted first, so no reply stays streaming, and the
 * starter is told that the reply ended. If that state cannot be stored, an
 * `AggregateError` of the failure and the storage failure is thrown instead,
 * after the starter was told.
 * @remarks The starter's hooks are called as {@link TurnDelegationHooks}
 * describes, and the turn's agent is handed the delegation they create. The
 * backend tools of the turn are the settings' tools, followed by the
 * attachment reader as {@link buildTurnBuiltInTools} adds it for a model
 * trained for tool use. A backend-started turn gets no title task, whatever
 * its conversation's title. A failure of either task, or of the starter's
 * `handleReplyEnded`, is logged as an error with the turn's logger.
 */
export function startTurn(
  dependencies: TurnStartDependencies,
  options: StartTurnOptions
): ReplyGeneration {
  const { turn, settings, startedBy, delegation, logger } = options
  const delegationContext: TurnDelegationContext = Object.freeze({
    turn,
    settings,
    startedBy
  })
  const target: ReplyTarget = {
    conversationId: turn.conversation.id,
    assistantMessageId: turn.assistantMessage.id
  }
  try {
    delegation.handleTurnStarted(delegationContext)
    const turnDelegation = delegation.createTurnDelegation(delegationContext)
    const input = buildTurnReplyInput(options, dependencies, turnDelegation)
    return dependencies.generations.startReplyGeneration(target, {
      startReplyTask: (context) =>
        createTurnReplyTask(dependencies, input, context),
      startTitleTask:
        startedBy === "person" && turn.conversation.title === null
          ? (context) => createTurnTitleTask(dependencies, options, context)
          : undefined,
      reportTaskFailure: (failure) => {
        handleTaskFailure(logger, failure)
      }
    })
  } catch (error) {
    handleTurnStartFailure(dependencies.turns, options, error)
    throw error
  }
}

/**
 * Ends the stored reply of a turn whose generation could not start: stores
 * it as interrupted, then tells the turn's starter that it ended.
 *
 * @param turns - Turn persistence borrowed while turns are started.
 * @param options - The stored turn, its starter's hooks, and its logger.
 * @param startFailure - What kept the generation from starting.
 * @throws An `AggregateError` holding `startFailure` followed by the
 * persistence failure when the state cannot be stored; the starter is told
 * all the same, before it is thrown.
 */
function handleTurnStartFailure(
  turns: TurnStartDependencies["turns"],
  options: Pick<StartTurnOptions, "turn" | "delegation" | "logger">,
  startFailure: unknown
): void {
  try {
    turns.updateAssistantMessageState(options.turn.assistantMessage.id, {
      status: "interrupted"
    })
  } catch (persistenceError) {
    throw new AggregateError(
      [startFailure, persistenceError],
      "Turn start failure could not be finalized",
      { cause: persistenceError }
    )
  } finally {
    handleTurnReplyEnded(options, undefined)
  }
}

/**
 * Tells the starter of a turn that the turn's reply ended.
 *
 * @param options - The stored turn, its starter's hooks, and its logger.
 * @param errorMessage - Sentence of the reply's `error` event; undefined
 * when the reply sent none.
 * @remarks A failure of the starter's `handleReplyEnded` is not thrown: it is
 * logged as an error with the turn's logger, like a failure of one of the
 * turn's tasks.
 */
function handleTurnReplyEnded(
  {
    turn,
    delegation,
    logger
  }: Pick<StartTurnOptions, "turn" | "delegation" | "logger">,
  errorMessage: string | undefined
): void {
  const reply: EndedReply = Object.freeze({
    conversationId: turn.conversation.id,
    assistantMessageId: turn.assistantMessage.id,
    errorMessage
  })
  try {
    delegation.handleReplyEnded(reply)
  } catch (failure) {
    handleTaskFailure(logger, failure)
  }
}

/**
 * Logs the failure of one of a turn's tasks, or of the starter's
 * `handleReplyEnded` for the turn's reply.
 *
 * @param logger - Logger of the turn.
 * @param failure - What the task rejected with, or the hook threw.
 */
function handleTaskFailure(logger: FastifyBaseLogger, failure: unknown): void {
  logger.error({ err: failure }, "Conversation task failed")
}

/**
 * Builds what a turn's reply task keeps, before the turn's generation starts.
 *
 * @param options - The stored turn, its agent, its settings, its starter's
 * hooks, and its logger.
 * @param dependencies - Attachment files, read while the reply is written.
 * @param turnDelegation - The turn's part in delegation, as its starter's
 * hooks created it.
 * @returns The options with the backend tools of the turn, which are the
 * settings' tools followed by the attachment reader as
 * {@link buildTurnBuiltInTools} adds it for a model trained for tool use,
 * the reader of the conversation's stored images, and the turn's delegation.
 */
function buildTurnReplyInput(
  options: StartTurnOptions,
  { attachmentFiles }: Pick<TurnStartDependencies, "attachmentFiles">,
  turnDelegation: TurnDelegation
): TurnReplyInput {
  const { turn, settings } = options
  const conversationId = turn.conversation.id
  const builtInTools = settings.trainedForToolUse
    ? buildTurnBuiltInTools(
        settings.builtInTools,
        listReadableAttachments(conversationId, [
          ...turn.conversation.messages,
          turn.userMessage
        ]),
        (location) => attachmentFiles.readAttachment(location)
      )
    : settings.builtInTools
  return {
    options,
    builtInTools,
    findAttachmentImage: buildAttachmentImageReader(
      conversationId,
      attachmentFiles
    ),
    turnDelegation
  }
}

/**
 * Builds the backend tools of a turn whose model is trained for tool use.
 *
 * @param offeredTools - Backend tools the turn's settings offer.
 * @param attachments - Every attachment of the conversation, the new
 * message's included.
 * @param readAttachmentFile - Reads an attachment's file; lent for the turn.
 * @returns The offered tools, followed by the attachment reader when an
 * attachment is a text file; the reader's calls run without approval, as
 * they read only what the person attached to this conversation. A model
 * that is not trained for tool use gets the offered tools alone, without a
 * call here.
 */
function buildTurnBuiltInTools(
  offeredTools: readonly TurnBuiltInTool[],
  attachments: readonly ReadableAttachment[],
  readAttachmentFile: ReadAttachmentFile
): readonly TurnBuiltInTool[] {
  if (!hasReadableTextAttachment(attachments)) return offeredTools
  return [
    ...offeredTools,
    {
      definition: buildReadAttachmentDefinition(),
      tool: new ReadAttachmentTool(attachments, readAttachmentFile),
      runsWithoutApproval: true
    }
  ]
}

/**
 * Runs one turn's reply task: has the agent write the reply and finalizes a
 * reply it left streaming, as {@link createTurnReply} describes, then tells
 * the turn's starter that the reply ended.
 *
 * @param dependencies - Persistence and approval gateway the reply uses.
 * @param input - Stored turn, its agent, and what the reply keeps.
 * @param context - Generation-owned cancellation, event sender, tool call
 * sender, and approval prompt sender.
 * @returns Settlement after the reply is final and the starter was told.
 * @throws As {@link createTurnReply} does, after the starter was told. The
 * generation reports it.
 * @remarks The starter is told the sentence of the reply's `error` event,
 * which is remembered as the agent sends the event: a follower of the
 * generation would receive the event too late. A failure of the starter's
 * `handleReplyEnded` is logged as {@link handleTurnReplyEnded} describes and
 * does not change how the task settles.
 */
async function createTurnReplyTask(
  dependencies: TurnReplyDependencies,
  input: TurnReplyInput,
  context: ReplyTaskContext
): Promise<void> {
  let errorMessage: string | undefined = undefined
  const replyContext: ReplyTaskContext = {
    ...context,
    sendEvent: (event) => {
      errorMessage = findErrorEventMessage(event) ?? errorMessage
      context.sendEvent(event)
    }
  }
  try {
    await createTurnReply(dependencies, input, replyContext)
  } finally {
    handleTurnReplyEnded(input.options, errorMessage)
  }
}

/**
 * Finds the sentence an event of a reply says the reply's failure with.
 *
 * @param event - One event a reply task sends.
 * @returns The message of an `error` event; undefined for any other event.
 */
function findErrorEventMessage(event: ChatGenerationEvent): string | undefined {
  return event.type === "error" ? event.message : undefined
}

/**
 * Has the turn's agent write its reply, then finalizes a reply it left
 * streaming.
 *
 * @param dependencies - Persistence and approval gateway the reply uses.
 * @param input - Stored turn, its agent, and what the reply keeps.
 * @param context - The reply task's cancellation, event sender, tool call
 * sender, and approval prompt sender.
 * @returns Settlement after the reply is final.
 * @throws The agent's failure after the fallback finalization; an
 * `AggregateError` of the agent's failure and the fallback's failure when the
 * fallback also fails; or the fallback's failure after an agent that
 * succeeded.
 * @remarks The fallback stores `interrupted` after cancellation and `failed`
 * otherwise; it changes nothing when the agent already finalized the reply.
 */
async function createTurnReply(
  dependencies: TurnReplyDependencies,
  input: TurnReplyInput,
  context: ReplyTaskContext
): Promise<void> {
  const { turn, agent } = input.options
  const { abortSignal } = context
  const assistantMessageId = turn.assistantMessage.id
  try {
    await agent.createReply(buildAgentTurn(dependencies, input, context))
  } catch (taskError) {
    try {
      updateUnfinishedReplyState(
        dependencies.turns,
        assistantMessageId,
        abortSignal
      )
    } catch (finalizationError) {
      throw new AggregateError(
        [taskError, finalizationError],
        "Reply failure could not be finalized",
        { cause: finalizationError }
      )
    }
    throw taskError
  }
  updateUnfinishedReplyState(
    dependencies.turns,
    assistantMessageId,
    abortSignal
  )
}

/**
 * Builds the turn the agent answers for one stored turn.
 *
 * @param dependencies - Persistence and approval gateway the reply uses.
 * @param input - Stored turn, its tools, its delegation, and what the reply
 * keeps.
 * @param context - The reply task's cancellation, event sender, tool call
 * sender, and approval prompt sender.
 * @returns The agent turn, whose parts and final state go to the stored
 * reply and whose reply state is read back from the stored conversation,
 * which numbers new sources after the conversation's stored ones,
 * whose tool calls pass the approval gateway, and whose images are read
 * from the conversation's attachment files. The turn's part in delegation
 * is the one its starter's hooks created. With the turn's logger, an
 * unreadable settings file, and a reply refused because its agent's request
 * slots and line were full, are logged as warnings; a cancelled reply, and a
 * round that was not sent because it did not fit or its model was not
 * loaded, at debug level; and any other reply failure as an error.
 */
function buildAgentTurn(
  dependencies: TurnReplyDependencies,
  input: TurnReplyInput,
  context: ReplyTaskContext
): AgentTurn {
  const { turn, settings, logger } = input.options
  const { toolApprovals } = dependencies
  const { sendToolApprovalPrompt } = context
  const storage = buildReplyStorage(dependencies, turn)
  const unreadableChoicesWarning =
    "The saved Just run choices could not be read from settings.json; every tool call of this round asks the person"
  return {
    conversationId: turn.conversation.id,
    requestId: turn.assistantMessage.id,
    history: turn.conversation.messages,
    sources: turn.conversation.sources,
    userMessage: turn.userMessage,
    canSeeImages: settings.canSeeImages,
    findAttachmentImage: input.findAttachmentImage,
    model: settings.model,
    trainedForToolUse: settings.trainedForToolUse,
    generationOptions: settings.generationOptions,
    clientTools: settings.clientTools,
    builtInTools: input.builtInTools,
    mcpTools: settings.mcpTools,
    unofferedTools: settings.unofferedTools,
    delegation: input.turnDelegation,
    abortSignal: context.abortSignal,
    createReplyPart: storage.createReplyPart,
    updateReplyPartContent: storage.updateReplyPartContent,
    updateReplyToolCall: storage.updateReplyToolCall,
    updateAssistantMessageState: storage.updateAssistantMessageState,
    findReplyStatus: storage.findReplyStatus,
    sendEvent: context.sendEvent,
    sendClientToolCall: context.sendClientToolCall,
    createToolCallGate: () =>
      toolApprovals.createToolCallGate(sendToolApprovalPrompt, () => {
        logger.warn(unreadableChoicesWarning)
      }),
    ...buildReplyFailureReporters(logger)
  }
}

/**
 * Builds how the agent stores one turn's reply and reads its state back.
 *
 * @param dependencies - Turn and reply-part persistence, and the lookup of
 * the stored conversation.
 * @param turn - The stored turn, whose reply the writes go to.
 * @returns Writes of the reply's parts and final state, each of which
 * answers as the persistence does for a reply that is no longer streaming,
 * and the read of the reply's state from the stored conversation.
 */
function buildReplyStorage(
  {
    turns,
    replyParts,
    findConversation
  }: Pick<TurnStartDependencies, "turns" | "replyParts" | "findConversation">,
  turn: ConversationTurn
): ReplyStorage {
  const assistantMessageId = turn.assistantMessage.id
  return {
    createReplyPart: (draft) =>
      replyParts.createReplyPart(assistantMessageId, draft),
    updateReplyPartContent: (partId, content) =>
      replyParts.updateReplyPartContent(assistantMessageId, partId, content),
    updateReplyToolCall: (toolCallId, change) =>
      replyParts.updateReplyToolCall(assistantMessageId, toolCallId, change),
    updateAssistantMessageState: (completion) =>
      turns.updateAssistantMessageState(assistantMessageId, completion),
    findReplyStatus: () =>
      findStoredReplyStatus(
        findConversation(turn.conversation.id),
        assistantMessageId
      )
  }
}

/**
 * Finds the status one reply of a conversation has as stored.
 *
 * @param conversation - The stored conversation; undefined when it is not
 * stored.
 * @param assistantMessageId - UUIDv7 of the reply.
 * @returns The reply's status; undefined when the conversation or the reply
 * is not stored.
 */
function findStoredReplyStatus(
  conversation: Conversation | undefined,
  assistantMessageId: string
): ConversationAssistantMessageStatus | undefined {
  const message = conversation?.messages.find(
    (stored) => stored.id === assistantMessageId
  )
  return message?.role === "assistant" ? message.status : undefined
}

/**
 * Builds the reporters that log how a reply ended without finishing.
 *
 * @param logger - Logger of the turn, borrowed for the reply.
 * @returns Reporters that log a reply refused because its agent's request
 * slots and line were full as a warning, a cancellation and a round that was
 * not sent because it did not fit or its model was not loaded as debug
 * entries, and a failed stream as an error.
 */
function buildReplyFailureReporters(
  logger: FastifyBaseLogger
): Pick<
  AgentTurn,
  "reportReplyCancellation" | "reportReplyRefusal" | "reportReplyFailure"
> {
  return {
    reportReplyCancellation: (failure) => {
      logger.debug({ err: failure }, "Chat completion was cancelled")
    },
    reportReplyRefusal: (failure) => {
      handleReplyRefusal(logger, failure)
    },
    reportReplyFailure: (failure) => {
      logger.error({ err: failure }, "Chat completion stream failed")
    }
  }
}

/**
 * Logs why a reply was refused before one of its rounds was sent.
 *
 * @param logger - Logger of the turn.
 * @param failure - Why the round was not sent: the agent's request slots and
 * line were full, which is logged as a warning; or the round did not fit or
 * its model was not loaded, which is logged at debug level.
 */
function handleReplyRefusal(
  logger: FastifyBaseLogger,
  failure: ReplyRefusal
): void {
  if (failure instanceof AgentRequestLimitError) {
    logger.warn(
      { err: failure },
      "Chat reply was refused because its agent was too busy"
    )
    return
  }
  logger.debug({ err: failure }, "Chat round was not sent to the model")
}

/**
 * Stores a final state for a reply its task left streaming.
 *
 * @param turns - Turn persistence borrowed while turns are started.
 * @param assistantMessageId - UUIDv7 of the reply.
 * @param abortSignal - The reply task's cancellation; aborted means the reply
 * was stopped, deleted with its conversation, or shut down.
 * @throws If the state cannot be stored.
 * @remarks Stores `interrupted` after cancellation and `failed` otherwise. A
 * reply that is already final, superseded, or deleted is left unchanged.
 */
function updateUnfinishedReplyState(
  turns: TurnStartDependencies["turns"],
  assistantMessageId: string,
  abortSignal: AbortSignal
): void {
  turns.updateAssistantMessageState(assistantMessageId, {
    status: abortSignal.aborted ? "interrupted" : "failed"
  })
}

/**
 * Runs one turn's title task for a conversation without a stored title.
 *
 * @param dependencies - Title generation, its loaded check and attempt limit,
 * and the title persistence.
 * @param options - Stored turn, the settings that name its model, and the
 * logger the task logs to.
 * @param context - Generation-owned cancellation and event sender.
 * @returns Settlement after the title is sent or its outcome is logged; it
 * does not reject.
 */
function createTurnTitleTask(
  dependencies: Pick<
    TurnStartDependencies,
    | "generateTitle"
    | "findLoadedContextLength"
    | "titleGenerationMaxAttempts"
    | "titleWriter"
  >,
  {
    turn,
    settings,
    logger
  }: Pick<StartTurnOptions, "turn" | "settings" | "logger">,
  { abortSignal, sendEvent }: ReplyGenerationTaskContext
): Promise<void> {
  return createTitleGenerationTask({
    generateTitle: dependencies.generateTitle,
    findLoadedContextLength: dependencies.findLoadedContextLength,
    userMessageContent: turn.userMessage.content,
    model: settings.model,
    abortSignal,
    sendEvent,
    logger,
    titleGenerationMaxAttempts: dependencies.titleGenerationMaxAttempts,
    updateConversationTitle: (title) =>
      dependencies.titleWriter.updateGeneratedConversationTitle(
        turn.conversation.id,
        title
      )
  })
}
