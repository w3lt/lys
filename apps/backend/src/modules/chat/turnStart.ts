import type { MessageGenerationOptions } from "@lys/protocol"
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
import { NO_TURN_DELEGATION } from "../agent/turnDelegation"
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
 * and the logger its tasks log to.
 * @returns The registered generation, as {@link startTurn} returns it.
 * @throws As {@link startTurn} does.
 */
export type StartTurn = (options: StartTurnOptions) => ReplyGeneration

/** What a started turn's reply task keeps until the reply is final. */
type TurnReplyInput = Readonly<{
  /** The stored turn, its agent, its settings, and its logger. */
  options: StartTurnOptions
  /**
   * Backend tools of the turn, each name once: the settings' tools, then the
   * attachment reader when the turn offers it; empty when none.
   */
  builtInTools: readonly TurnBuiltInTool[]
  /** Reads the bytes of one stored image attachment of the conversation. */
  findAttachmentImage: FindAttachmentImage
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
 * and the logger its tasks log to.
 * @returns The registered generation. Open its first followers before
 * awaiting anything, so they receive every task event.
 * @throws If the registry no longer admits generations; the stored reply is
 * finalized as interrupted first, so no reply stays streaming.
 * @remarks The backend tools of the turn are the settings' tools, followed by
 * the attachment reader as {@link buildTurnBuiltInTools} adds it for a model
 * trained for tool use. A backend-started turn gets no title task, whatever
 * its conversation's title. A failure of either task is logged as an error
 * with the turn's logger.
 */
export function startTurn(
  dependencies: TurnStartDependencies,
  options: StartTurnOptions
): ReplyGeneration {
  const { turn, logger } = options
  const input = buildTurnReplyInput(options, dependencies)
  const target: ReplyTarget = {
    conversationId: turn.conversation.id,
    assistantMessageId: turn.assistantMessage.id
  }
  try {
    return dependencies.generations.startReplyGeneration(target, {
      startReplyTask: (context) =>
        createTurnReplyTask(dependencies, input, context),
      startTitleTask:
        options.startedBy === "person" && turn.conversation.title === null
          ? (context) => createTurnTitleTask(dependencies, options, context)
          : undefined,
      reportTaskFailure: (error) => {
        logger.error({ err: error }, "Conversation task failed")
      }
    })
  } catch (error) {
    dependencies.turns.updateAssistantMessageState(turn.assistantMessage.id, {
      status: "interrupted"
    })
    throw error
  }
}

/**
 * Builds what a turn's reply task keeps, before the turn's generation starts.
 *
 * @param options - The stored turn, its agent, its settings, and its logger.
 * @param dependencies - Attachment files, read while the reply is written.
 * @returns The options with the backend tools of the turn, which are the
 * settings' tools followed by the attachment reader as
 * {@link buildTurnBuiltInTools} adds it for a model trained for tool use, and
 * the reader of the conversation's stored images.
 */
function buildTurnReplyInput(
  options: StartTurnOptions,
  { attachmentFiles }: Pick<TurnStartDependencies, "attachmentFiles">
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
    )
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
 * Has the turn's agent write its reply, then finalizes a reply it left
 * streaming.
 *
 * @param dependencies - Persistence and approval gateway the reply uses.
 * @param input - Stored turn, its agent, and what the reply keeps.
 * @param context - Generation-owned cancellation, event sender, tool call
 * sender, and approval prompt sender.
 * @returns Settlement after the reply is final.
 * @throws The agent's failure after the fallback finalization; an
 * `AggregateError` of the agent's failure and the fallback's failure when the
 * fallback also fails; or the fallback's failure after an agent that
 * succeeded. The generation reports it.
 * @remarks The fallback stores `interrupted` after cancellation and `failed`
 * otherwise; it changes nothing when the agent already finalized the reply.
 */
async function createTurnReplyTask(
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
 * @param input - Stored turn, its tools, and what the reply keeps.
 * @param context - Generation-owned cancellation, event sender, tool call
 * sender, and approval prompt sender.
 * @returns The agent turn, whose parts and final state go to the stored
 * reply and whose reply state is read back from the stored conversation,
 * which numbers new sources after the conversation's stored ones,
 * whose tool calls pass the approval gateway, and whose images are read
 * from the conversation's attachment files. The turn takes no part in
 * delegation: it offers no delegation tool, and its instructions carry no
 * note about a job. With the turn's logger, an
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
    delegation: NO_TURN_DELEGATION,
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
 * was stopped or shut down.
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
