import {
  CALIGINIA_AGENT_CODE,
  DELEGATE_WORK_TOOL_NAME,
  type Job
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import { expect, onTestFinished, vi, type Mock } from "vitest"
import SqliteAgentRecordStore from "../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import SqliteJobActivityReader from "../../../src/infrastructure/database/delegation/sqliteJobActivityReader"
import SqliteJobReader from "../../../src/infrastructure/database/delegation/sqliteJobReader"
import SqliteJobReportWriter from "../../../src/infrastructure/database/delegation/sqliteJobReportWriter"
import { createBackendLogger } from "../../../src/log"
import type ActivityHub from "../../../src/modules/activity/activityHub"
import type { AssistantMessageCompletion } from "../../../src/modules/agent/agent"
import AgentRuntimeService, {
  buildConversationTitleLookup
} from "../../../src/modules/agent/agentRuntimeService"
import AgentService from "../../../src/modules/agent/agentService"
import { buildBuiltInAgents } from "../../../src/modules/agent/builtInAgents"
import type { ReplyModel } from "../../../src/modules/agent/replyModel"
import type {
  JobMessageDraft,
  TurnDelegation
} from "../../../src/modules/agent/turnDelegation"
import { NO_UNOFFERED_TOOLS } from "../../../src/modules/agent/unofferedTools"
import type {
  ConversationTurnTarget,
  ConversationTurnWriter,
  ReplyPartWriter
} from "../../../src/modules/chat/persistence"
import type ReplyGeneration from "../../../src/modules/chat/replyGeneration"
import ReplyGenerationRegistry, {
  type ReplyTarget
} from "../../../src/modules/chat/replyGenerationRegistry"
import type {
  EndedReply,
  StartTurnOptions,
  TurnDelegationContext,
  TurnSettings
} from "../../../src/modules/chat/turnStart"
import type { ConversationReader } from "../../../src/modules/conversation/capabilities"
import ConversationWakeSettings from "../../../src/modules/delegation/conversationWakeSettings"
import type { DelegationEvent } from "../../../src/modules/delegation/delegationEvent"
import { createDelegationRuntime } from "../../../src/modules/delegation/delegationRuntime"
import type {
  DelegationAgentLookups,
  DelegationDependencies,
  DelegationRuntime
} from "../../../src/modules/delegation/dependencies"
import { createJobMessage } from "../../../src/modules/delegation/jobMessages"
import ReplyStopRequests from "../../../src/modules/delegation/replyStopRequests"
import { TEST_BACKEND_CONFIG } from "./backendConfig"
import {
  openConversationTestServices,
  type ConversationTestServices
} from "./conversationDatabase"
import {
  ASK_ME_TOOL_CALL_DECISION,
  createNewConversationTarget,
  createTurnUserMessage
} from "./conversationFixtures"
import { CapturedLogDestination } from "./fastifyTestApp"
import { LM_STUDIO_QWEN3_8B } from "./llmFixtures"
import { createRoomyReplyContextMeter } from "./replyContextMeterFakes"
import { createToolSearchCallRecords } from "./toolFixtures"

/** Code of the member most cases give work to. */
export const FIRST_MEMBER = "researcher"

/** Display name of {@link FIRST_MEMBER}. */
export const FIRST_MEMBER_NAME = "Researcher"

/** Code of the other member that takes work. */
export const SECOND_MEMBER = "archivist"

/** Code of a member that was deleted before every case. */
export const DELETED_MEMBER = "scribe"

/** Definition of {@link FIRST_MEMBER}, which a case's agent service stores. */
export const FIRST_MEMBER_DEFINITION = Object.freeze({
  code: FIRST_MEMBER,
  name: FIRST_MEMBER_NAME,
  bio: "Finds things out.",
  systemPrompt: "You research what you are asked about."
})

/** Sampling of every turn a case starts. */
const TEST_GENERATION_OPTIONS = Object.freeze({ temperature: 0.4 })

/** Tools of a kind that a case's turn does not offer. */
const NO_TOOLS: readonly never[] = Object.freeze([])

/**
 * Settings of a person's turn that offers `delegate_work` and no other tool,
 * for `qwen/qwen3-8b` on LM Studio, trained for tool use and seeing no
 * images.
 */
export const DELEGATING_TURN_SETTINGS: TurnSettings = Object.freeze({
  model: LM_STUDIO_QWEN3_8B,
  generationOptions: TEST_GENERATION_OPTIONS,
  clientTools: NO_TOOLS,
  builtInTools: NO_TOOLS,
  mcpTools: NO_TOOLS,
  offersDelegateWork: true,
  unofferedTools: NO_UNOFFERED_TOOLS,
  canSeeImages: false,
  trainedForToolUse: true
})

/** What a case's `delegate_work` call asks, before its call is stored. */
export type JobMessageRequest = Pick<
  JobMessageDraft,
  "agentCode" | "title" | "instructions" | "jobNumber"
>

/** Work most cases give {@link FIRST_MEMBER}: a new job titled `Moths`. */
export const MOTHS_REQUEST: JobMessageRequest = Object.freeze({
  agentCode: FIRST_MEMBER,
  title: "Moths",
  instructions: "Find what moths eat",
  jobNumber: undefined
})

/** State a case stores a started reply in when it ends the reply. */
export type ScriptedReplyStatus = "completed" | "failed" | "interrupted"

/** One turn the scripted turn start started. */
export type ScriptedTurn = Readonly<{
  /** What the turn was started with. */
  options: StartTurnOptions
  /** The context the options' hooks were handed for the turn. */
  context: TurnDelegationContext
  /** The delegation the options' hooks created for the turn. */
  delegation: TurnDelegation
  /** The turn's generation, registered until its reply ended. */
  generation: ReplyGeneration
}>

/** Hub fake that records what delegation tells the activity streams. */
export type RecordingActivityHub = Readonly<{
  /** Records each reply delegation started; follows nothing. */
  addReply: Mock<ActivityHub["addReply"]>
  /** Records each reply whose end was handled. */
  removeReply: Mock<ActivityHub["removeReply"]>
  /** Records each job update. */
  sendJobUpdate: Mock<ActivityHub["sendJobUpdate"]>
}>

/** What a case's delegation runtime allows, and where it stores. */
export type DelegationTestOptions = Readonly<{
  /**
   * Job messages agents may send in one main conversation since the
   * person's last message there; that of the test backend configuration
   * when omitted.
   */
  agentJobMessageLimit?: number
  /**
   * SQLite location of the runtime's database, in a directory the case
   * owns; an isolated in-memory database when omitted. A second runtime
   * opened on the file of a first one finds what the first one stored, as
   * the backend does after a restart.
   */
  databaseFilePath?: string
}>

/**
 * A delegation runtime over stores the current test owns, with the case's
 * controls and what the runtime was observed doing.
 */
export type DelegationTestServices = Readonly<{
  /** The runtime under test, as {@link createDelegationRuntime} built it. */
  runtime: DelegationRuntime
  /**
   * Conversation services over the database the runtime's job records read
   * and write.
   */
  conversation: ConversationTestServices
  /** Hub the runtime tells which replies it started and how jobs changed. */
  hub: RecordingActivityHub
  /**
   * Registry the scripted turn start registers each generation with, where
   * the runtime finds running generations; a case may register generations
   * of its own. Disposed when the test finishes.
   */
  generations: ReplyGenerationRegistry
  /** Event reporter of the runtime; records each event. */
  reportEvent: Mock<(event: DelegationEvent) => void>
  /**
   * Lists the turns the runtime's turn start started.
   *
   * @returns A frozen list, in start order.
   */
  listStartedTurns: () => readonly ScriptedTurn[]
  /**
   * Finds the turn the runtime's turn start started for a reply.
   *
   * @param assistantMessageId - UUIDv7 of the turn's reply.
   * @returns The started turn.
   * @throws If no turn was started for the reply.
   */
  findStartedTurn: (assistantMessageId: string) => ScriptedTurn
  /**
   * Ends a started reply, then waits until its end was handled.
   *
   * @param assistantMessageId - UUIDv7 of the reply.
   * @param status - State the reply is stored in.
   * @param errorMessage - Sentence of the reply's `error` event; none when
   * omitted.
   * @returns A promise that resolves once the reply's state was stored and
   * the hooks it was started with were told that it ended.
   * @throws If no turn was started for the reply.
   */
  resolveReply: (
    assistantMessageId: string,
    status: ScriptedReplyStatus,
    errorMessage?: string
  ) => Promise<void>
}>

/**
 * What {@link waitForFirstJobReplyEnd} reads and waits on, as a backend's
 * services name them.
 */
export type JobReplyServices = Readonly<{
  /** Reads a main conversation, which lists its jobs. */
  conversationHistoryReader: ConversationReader
  /** Holds each running reply's generation until it settles. */
  replyGenerations: Pick<ReplyGenerationRegistry, "findReplyGeneration">
}>

/** How one scripted reply ends. */
type ScriptedReplyEnding = Readonly<{
  /** State the reply is stored in. */
  status: ScriptedReplyStatus
  /** Sentence of the reply's `error` event; undefined when it sent none. */
  errorMessage: string | undefined
}>

/** One started turn, with the ending its reply waits for. */
type ScriptedReply = Readonly<{
  /** The started turn. */
  started: ScriptedTurn
  /** Resolved with how the reply ends when the case ends it. */
  ending: PromiseWithResolvers<ScriptedReplyEnding>
}>

/** What the scripted turn start borrows and keeps. */
type ScriptedTurnStart = Readonly<{
  /** Registry every started turn's generation is registered with. */
  generations: ReplyGenerationRegistry
  /** Stores each reply's final state. */
  turns: Pick<ConversationTurnWriter, "updateAssistantMessageState">
  /** Started replies by their identity, in start order. */
  replies: Map<string, ScriptedReply>
  /**
   * Failures of the reply tasks, and throws of `handleReplyEnded` for a
   * reply that could not start, which fail the case when it finishes.
   */
  taskFailures: unknown[]
}>

/** What the task of one scripted reply runs with. */
type ScriptedReplyTask = Readonly<{
  /** Stores the reply's final state. */
  turns: ScriptedTurnStart["turns"]
  /** The stored turn, and the hook told that its reply ended. */
  options: Pick<StartTurnOptions, "turn" | "handleReplyEnded">
  /** Resolves with the case's ending once the case ends the reply. */
  ending: Promise<ScriptedReplyEnding>
}>

/**
 * What a case's runtime borrows that the case chooses or observes: the hub
 * fake, the event recorder, and the limit of job messages.
 */
type CaseDependencies = Pick<
  DelegationDependencies,
  "hub" | "reportEvent" | "agentJobMessageLimit"
>

/**
 * Opens a delegation runtime over stores the current test owns.
 *
 * @param options - What the runtime allows, and where it stores; the test
 * backend configuration's limit of job messages, and an in-memory database,
 * by default.
 * @returns The runtime and the case's controls and observations. The
 * runtime's job records are the Sqlite ones over the database it shares
 * with the conversation services, whose creation settles what an earlier
 * runtime left streaming there. Its agent lookups know Caliginia and
 * Lysiptera, the leaders; {@link FIRST_MEMBER} and {@link SECOND_MEMBER},
 * members; and {@link DELETED_MEMBER}, a deleted member. Its wake settings
 * and stop requests are real; its hub records and follows nothing; its
 * events are recorded; it logs to a destination no case reads. Its turn
 * start is scripted, as {@link startScriptedTurn} describes, over a real
 * reply generation registry, which the services return.
 * @remarks When the test finishes, the registry is disposed first, which
 * ends every reply still running as interrupted; then the case fails if a
 * reply task failed; then the database is closed. A runtime opened later in
 * the case does all three before one opened earlier.
 */
export function openDelegationTestServices(
  options: DelegationTestOptions = {}
): DelegationTestServices {
  const conversation = openConversationTestServices(options.databaseFilePath)
  const start = createScriptedTurnStart(conversation.turns)
  const hub = createRecordingActivityHub()
  const reportEvent = vi.fn<(event: DelegationEvent) => void>()
  const agentJobMessageLimit =
    options.agentJobMessageLimit ?? TEST_BACKEND_CONFIG.agentJobMessageLimit
  const caseDependencies: CaseDependencies = Object.freeze({
    hub,
    reportEvent,
    agentJobMessageLimit
  })
  const runtime = createDelegationRuntime(
    buildDelegationDependencies(conversation, start, caseDependencies)
  )
  return Object.freeze({
    runtime,
    conversation,
    hub,
    generations: start.generations,
    reportEvent,
    listStartedTurns: () =>
      Object.freeze([...start.replies.values()].map(({ started }) => started)),
    findStartedTurn: (assistantMessageId) =>
      findScriptedReply(start.replies, assistantMessageId).started,
    resolveReply: (assistantMessageId, status, errorMessage) =>
      resolveScriptedReply(start.replies, assistantMessageId, {
        status,
        errorMessage
      })
  })
}

/**
 * Creates the scripted turn start's registry and records, owned by the
 * current test.
 *
 * @param turns - Stores each reply's final state; outlives every reply.
 * @returns The registry, the replies started so far, and the failures of
 * their tasks. When the test finishes, the registry is disposed, then the
 * case fails, listing the failures, if any reply task failed.
 */
function createScriptedTurnStart(
  turns: ScriptedTurnStart["turns"]
): ScriptedTurnStart {
  const taskFailures: unknown[] = []
  onTestFinished(() => {
    expect(taskFailures).toEqual([])
  })
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  const replies = new Map<string, ScriptedReply>()
  return Object.freeze({ generations, turns, replies, taskFailures })
}

/**
 * Creates the hub fake of a case.
 *
 * @returns A hub whose methods record their calls and do nothing else.
 */
function createRecordingActivityHub(): RecordingActivityHub {
  return Object.freeze({
    addReply: vi.fn<ActivityHub["addReply"]>(),
    removeReply: vi.fn<ActivityHub["removeReply"]>(),
    sendJobUpdate: vi.fn<ActivityHub["sendJobUpdate"]>()
  })
}

/**
 * Builds what a case's runtime borrows.
 *
 * @param conversation - Conversation services over the case's database.
 * @param start - The scripted turn start's registry and records.
 * @param caseDependencies - The hub fake, the event recorder, and the limit
 * of job messages.
 * @returns The dependencies, as {@link openDelegationTestServices}
 * describes them.
 */
function buildDelegationDependencies(
  conversation: ConversationTestServices,
  start: ScriptedTurnStart,
  caseDependencies: CaseDependencies
): DelegationDependencies {
  const lookups = createTestAgentLookups(conversation)
  const jobs = new SqliteJobReader(conversation.database)
  const jobActivity = new SqliteJobActivityReader(conversation.database)
  const reports = new SqliteJobReportWriter(conversation.database)
  const wakeSettings = new ConversationWakeSettings()
  const stopRequests = new ReplyStopRequests()
  const logger = createBackendLogger(new CapturedLogDestination())
  return Object.freeze({
    findAgent: lookups.findAgent,
    loadChatAgent: lookups.loadChatAgent,
    findConversationAgentCode: lookups.findConversationAgentCode,
    jobs,
    jobActivity,
    reports,
    turns: conversation.turns,
    startTurn: (turnOptions) => startScriptedTurn(start, turnOptions),
    generations: start.generations,
    hub: caseDependencies.hub,
    wakeSettings,
    stopRequests,
    agentJobMessageLimit: caseDependencies.agentJobMessageLimit,
    reportEvent: caseDependencies.reportEvent,
    logger
  })
}

/**
 * Creates the agent lookups of a case over an agent service on the case's
 * database.
 *
 * @param conversation - The case's database, and the history the live
 * agents title their requests' conversations from.
 * @returns Lookups that find Caliginia and Lysiptera, the stored members,
 * and the deleted member, and load the live agents of all but the deleted
 * one.
 * @throws If a member cannot be stored or deleted.
 * @remarks The members are stored only when the database holds none yet;
 * a database an earlier runtime of the case opened already holds them.
 */
function createTestAgentLookups(
  conversation: ConversationTestServices
): DelegationAgentLookups {
  /**
   * Built-in agents of every case's agent service: Caliginia, Lysiptera, and
   * Armitage.
   */
  const testBuiltInAgents = buildBuiltInAgents({
    caliginia: "You are Caliginia.",
    lysiptera: "You are Lysiptera.",
    armitage: "You are Armitage."
  })

  const recordStore = SqliteAgentRecordStore.create(conversation.database)
  const agentService = new AgentService({
    recordStore,
    builtInAgents: testBuiltInAgents
  })
  if (agentService.findAgent(FIRST_MEMBER) === undefined)
    saveTestMembers(agentService)
  const runtimeService = createTestAgentRuntimeService(
    agentService,
    conversation
  )
  return Object.freeze({
    findAgent: (code) => agentService.findAgent(code),
    loadChatAgent: (code) => runtimeService.loadChatAgent(code),
    findConversationAgentCode: (conversationId) =>
      conversation.history.getConversationMetadata(conversationId)?.agentCode
  })
}

/**
 * Stores the members of a case in the order of `memberDefinitions`,
 * then deletes {@link DELETED_MEMBER}.
 *
 * @param agentService - Agent service over a database that holds no member.
 * @throws If a member cannot be stored or deleted.
 */
function saveTestMembers(agentService: AgentService): void {
  /** Definition of {@link SECOND_MEMBER}. */
  const secondMemberDefinition = Object.freeze({
    code: SECOND_MEMBER,
    name: "Archivist",
    bio: "Keeps records.",
    systemPrompt: "You keep records of what you are given."
  })

  /** Definition of {@link DELETED_MEMBER}, before it was deleted. */
  const deletedMemberDefinition = Object.freeze({
    code: DELETED_MEMBER,
    name: "Scribe",
    bio: "Writes things down.",
    systemPrompt: "You write down what you are told."
  })

  /**
   * Stored agents of every case's agent service, in creation order: the two
   * members that take work, then {@link DELETED_MEMBER}, which is deleted once
   * created.
   */
  const memberDefinitions = Object.freeze([
    FIRST_MEMBER_DEFINITION,
    secondMemberDefinition,
    deletedMemberDefinition
  ])

  for (const definition of memberDefinitions)
    if (agentService.createAgent(definition) === undefined)
      throw new Error(`The member ${definition.code} could not be stored`)
  if (agentService.deleteAgent(DELETED_MEMBER) !== "deleted")
    throw new Error("The deleted member could not be deleted")
}

/**
 * Creates the agent runtime service of a case, whose live agents no case
 * runs.
 *
 * @param agentService - The agents it makes live.
 * @param conversation - The history the live agents title their requests'
 * conversations from.
 * @returns The service; each live agent has `requestLimits`, a meter
 * that finds every model loaded with room to spare, and model access that
 * rejects. Its tool searches' call records are kept in memory, and Lys has
 * no email address.
 */
function createTestAgentRuntimeService(
  agentService: AgentService,
  conversation: Pick<ConversationTestServices, "history">
): AgentRuntimeService {
  /**
   * Request limits of every live agent of a case: two replies at once, one more
   * waiting.
   */
  const requestLimits = Object.freeze({ slotCount: 2, waitingLimit: 1 })

  /** Model access no case's agent calls: the scripted turn start runs none. */
  const unusedReplyModel = Object.freeze({
    openReplyStream: () =>
      Promise.reject(new Error("Unexpected model call in a delegation case"))
  } satisfies ReplyModel)

  const replyContextMeter = createRoomyReplyContextMeter()
  return new AgentRuntimeService({
    agents: agentService,
    replyModel: unusedReplyModel,
    replyContextMeter,
    findConversationTitle: (conversationId) =>
      buildConversationTitleLookup(
        conversation.history.getConversation(conversationId)
      ),
    requestLimits,
    toolSearchCallRecords: createToolSearchCallRecords().records,
    readLysEmailAddress: () => null
  })
}

/**
 * Starts one stored turn as the real turn start does for delegation, with a
 * reply the case ends.
 *
 * @param start - The registry the generation is registered with, and the
 * records the turn is added to.
 * @param options - The stored turn, its agent, its settings, who starts it,
 * the starter's hooks, and its logger.
 * @returns The registered generation, which runs no title task.
 * @throws What the options' `handleTurnStarted` or `createTurnDelegation`
 * throws, or the registry when it no longer admits generations; nothing is
 * registered then, and the reply is ended first, as
 * {@link handleScriptedTurnStartFailure} describes, which throws an
 * `AggregateError` instead when the reply's state cannot be stored.
 * @remarks Calls the options' `handleTurnStarted`, then their
 * `createTurnDelegation`, with the turn's context. The reply's task waits
 * until the case ends the reply with {@link DelegationTestServices.resolveReply},
 * or until the generation is stopped or disposed, which ends it as
 * interrupted. It stores the reply's final state, then tells the options'
 * `handleReplyEnded`, also when the state could not be stored. Unlike the
 * real turn start, it does not run the agent, and a throw of
 * `handleReplyEnded` fails the reply task, which fails the case when it
 * finishes.
 */
function startScriptedTurn(
  start: ScriptedTurnStart,
  options: StartTurnOptions
): ReplyGeneration {
  const { turn, settings, startedBy } = options
  const context: TurnDelegationContext = Object.freeze({
    turn,
    settings,
    startedBy
  })
  try {
    options.handleTurnStarted(context)
    const delegation = options.createTurnDelegation(context)
    const ending = Promise.withResolvers<ScriptedReplyEnding>()
    const task: ScriptedReplyTask = Object.freeze({
      turns: start.turns,
      options,
      ending: ending.promise
    })
    const target: ReplyTarget = Object.freeze({
      conversationId: turn.conversation.id,
      assistantMessageId: turn.assistantMessage.id
    })
    const generation = start.generations.startReplyGeneration(target, {
      startReplyTask: ({ abortSignal }) => runScriptedReply(task, abortSignal),
      startTitleTask: undefined,
      reportTaskFailure: (failure) => {
        start.taskFailures.push(failure)
      }
    })
    const started: ScriptedTurn = Object.freeze({
      options,
      context,
      delegation,
      generation
    })
    const reply: ScriptedReply = Object.freeze({ started, ending })
    start.replies.set(turn.assistantMessage.id, reply)
    return generation
  } catch (error) {
    handleScriptedTurnStartFailure(start, options, error)
    throw error
  }
}

/**
 * Ends the stored reply of a scripted turn whose generation could not
 * start, as the real turn start does: stores it as interrupted, then tells
 * the options' `handleReplyEnded` that it ended.
 *
 * @param start - Stores the reply's final state, and keeps a throw of
 * `handleReplyEnded`.
 * @param options - The stored turn, and the hook told that its reply
 * ended.
 * @param startFailure - What kept the generation from starting.
 * @throws An `AggregateError` holding `startFailure` followed by the
 * persistence failure when the state cannot be stored; the hook is told all
 * the same, before it is thrown.
 * @remarks The reply ends without an error sentence. A throw of
 * `handleReplyEnded`, which the real turn start logs, is kept with the reply
 * tasks' failures, which fail the case when it finishes.
 */
function handleScriptedTurnStartFailure(
  start: Pick<ScriptedTurnStart, "turns" | "taskFailures">,
  options: Pick<StartTurnOptions, "turn" | "handleReplyEnded">,
  startFailure: unknown
): void {
  const { conversation, assistantMessage } = options.turn
  const reply: EndedReply = Object.freeze({
    conversationId: conversation.id,
    assistantMessageId: assistantMessage.id,
    errorMessage: undefined
  })
  try {
    start.turns.updateAssistantMessageState(assistantMessage.id, {
      status: "interrupted"
    })
  } catch (persistenceError) {
    throw new AggregateError(
      [startFailure, persistenceError],
      "Turn start failure could not be finalized",
      { cause: persistenceError }
    )
  } finally {
    try {
      options.handleReplyEnded(reply)
    } catch (failure) {
      start.taskFailures.push(failure)
    }
  }
}

/**
 * Waits for how a scripted reply ends.
 *
 * @param ending - Resolves with the case's ending once the case ends the
 * reply.
 * @param abortSignal - Cancellation of the reply task, aborted when its
 * generation is stopped or disposed.
 * @returns The case's ending, or an `interrupted` ending without an error
 * message once the signal aborts first. An ending the case gave before the
 * stop wins, also when both came before the task started.
 */
async function waitForReplyEnding(
  ending: Promise<ScriptedReplyEnding>,
  abortSignal: AbortSignal
): Promise<ScriptedReplyEnding> {
  const stopped = Promise.withResolvers<ScriptedReplyEnding>()
  /**
   * Resolves the stop with an `interrupted` ending without an error
   * message. The abort listener calls it, or the wait calls it at once when
   * the signal had already aborted.
   */
  const resolveStopped = () => {
    /** Ending of a reply whose generation was stopped or disposed. */
    const stoppedReplyEnding: ScriptedReplyEnding = Object.freeze({
      status: "interrupted",
      errorMessage: undefined
    })

    stopped.resolve(stoppedReplyEnding)
  }
  abortSignal.addEventListener("abort", resolveStopped, { once: true })
  if (abortSignal.aborted) resolveStopped()
  try {
    return await Promise.race([ending, stopped.promise])
  } finally {
    abortSignal.removeEventListener("abort", resolveStopped)
  }
}

/**
 * Runs the task of a scripted reply.
 *
 * @param task - The reply's turn, its hooks, its state store, and the
 * case's ending.
 * @param abortSignal - Cancellation of the task, aborted when its
 * generation is stopped or disposed.
 * @returns A promise that resolves once the reply's state was stored and
 * the hooks were told that it ended.
 * @throws What storing the state throws, after the hooks were told; or what
 * the hooks' `handleReplyEnded` throws.
 */
async function runScriptedReply(
  task: ScriptedReplyTask,
  abortSignal: AbortSignal
): Promise<void> {
  const ending = await waitForReplyEnding(task.ending, abortSignal)
  const { conversation, assistantMessage } = task.options.turn
  const reply: EndedReply = Object.freeze({
    conversationId: conversation.id,
    assistantMessageId: assistantMessage.id,
    errorMessage: ending.errorMessage
  })
  try {
    task.turns.updateAssistantMessageState(
      assistantMessage.id,
      buildReplyCompletion(ending.status)
    )
  } finally {
    task.options.handleReplyEnded(reply)
  }
}

/**
 * Builds the final state a scripted reply is stored in.
 *
 * @param status - State the case ends the reply in.
 * @returns The `completed` state, which finished with `stop`, for a
 * completed reply; otherwise the state alone.
 */
function buildReplyCompletion(
  status: ScriptedReplyStatus
): AssistantMessageCompletion {
  /** Final state of a reply a case ends as completed. */
  const completedReply: AssistantMessageCompletion = Object.freeze({
    status: "completed",
    finishReason: "stop"
  })

  return status === "completed" ? completedReply : Object.freeze({ status })
}

/**
 * Finds a started reply of a case.
 *
 * @param replies - Started replies by their identity.
 * @param assistantMessageId - UUIDv7 of the reply.
 * @returns The started reply.
 * @throws If no turn was started for the reply.
 */
function findScriptedReply(
  replies: ReadonlyMap<string, ScriptedReply>,
  assistantMessageId: string
): ScriptedReply {
  const reply = replies.get(assistantMessageId)
  if (reply === undefined) throw new Error("No turn was started for this reply")
  return reply
}

/**
 * Ends a started reply, then waits until its end was handled.
 *
 * @param replies - Started replies by their identity.
 * @param assistantMessageId - UUIDv7 of the reply.
 * @param ending - How the reply ends.
 * @returns A promise that resolves once the reply's generation settled:
 * its state was stored, and its hooks were told.
 * @throws If no turn was started for the reply.
 */
async function resolveScriptedReply(
  replies: ReadonlyMap<string, ScriptedReply>,
  assistantMessageId: string,
  ending: ScriptedReplyEnding
): Promise<void> {
  const reply = findScriptedReply(replies, assistantMessageId)
  reply.ending.resolve(ending)
  await reply.started.generation.settled
}

/** Conversation a turn of the person's starts or continues. */
type PersonTurnTarget = Extract<
  ConversationTurnTarget,
  { kind: "new" | "existing" }
>

/**
 * Stores a turn of the person's and builds the context its starter's hooks
 * are handed, as the chat route stores one before it starts it.
 *
 * @param turns - Stores the turn.
 * @param target - Conversation the turn starts or continues; a new one
 * that Caliginia answers by default.
 * @param settings - Settings the turn is started with;
 * {@link DELEGATING_TURN_SETTINGS} by default.
 * @returns The context of the stored turn, whose reply is streaming and has
 * no generation. The person's message asks about moths, and the reply is
 * written with the settings' model.
 * @throws If the turn cannot be stored.
 */
export function createPersonTurn(
  turns: Pick<ConversationTurnWriter, "createConversationTurn">,
  target: PersonTurnTarget = createNewConversationTarget(CALIGINIA_AGENT_CODE),
  settings: TurnSettings = DELEGATING_TURN_SETTINGS
): TurnDelegationContext {
  const userMessage = createTurnUserMessage("Collect information about moths")
  const turn = turns.createConversationTurn({
    conversation: target,
    userMessage,
    model: settings.model
  })
  return Object.freeze({ turn, settings, startedBy: "person" })
}

/**
 * Stores a turn of the person's and starts it as the chat route starts one:
 * with the runtime's hooks, so the turn takes part in delegation, and with
 * a reply the case ends with {@link DelegationTestServices.resolveReply}.
 *
 * @param services - The case's runtime and conversation services.
 * @param target - Conversation the turn starts or continues; a new one
 * that Caliginia answers by default.
 * @param settings - Settings the turn is stored and started with;
 * {@link DELEGATING_TURN_SETTINGS} by default.
 * @returns The context of the started turn, as {@link createPersonTurn}
 * builds it; its reply streams until the case ends it.
 * @throws If the turn cannot be stored, the agent of its conversation
 * cannot be loaded, or the turn start throws.
 */
export function startPersonTurn(
  services: Pick<DelegationTestServices, "runtime" | "conversation">,
  target?: PersonTurnTarget,
  settings: TurnSettings = DELEGATING_TURN_SETTINGS
): TurnDelegationContext {
  const { runtime } = services
  const context = createPersonTurn(
    services.conversation.turns,
    target,
    settings
  )
  const agent = runtime.loadChatAgent(context.turn.conversation.agentCode)
  if (agent === undefined)
    throw new Error("The agent of the person's conversation cannot be loaded")
  runtime.startTurn({
    turn: context.turn,
    agent,
    settings,
    startedBy: "person",
    handleTurnStarted: runtime.handleTurnStarted,
    createTurnDelegation: runtime.createTurnDelegation,
    handleReplyEnded: runtime.handleReplyEnded,
    logger: runtime.logger
  })
  return context
}

/**
 * Stores a wake-up turn in a main conversation and builds the context its
 * starter's hooks are handed.
 *
 * @param turns - Stores the turn.
 * @param conversationId - UUIDv7 of the stored main conversation.
 * @param settings - Settings the turn is started with.
 * @returns The context of the stored turn, started by the backend, whose
 * reply is streaming and has no generation.
 * @throws If the turn cannot be stored.
 */
export function createWakeUpTurn(
  turns: Pick<ConversationTurnWriter, "createConversationTurn">,
  conversationId: string,
  settings: TurnSettings
): TurnDelegationContext {
  const userMessage = createTurnUserMessage("Reports of your jobs arrived.")
  const conversation: ConversationTurnTarget = Object.freeze({
    kind: "wake-up",
    id: conversationId
  })
  const turn = turns.createConversationTurn({
    conversation,
    userMessage,
    model: settings.model
  })
  return Object.freeze({ turn, settings, startedBy: "backend" })
}

/**
 * Builds the draft of a job message a delegating turn sends, storing the
 * turn's `delegate_work` call that sends it, as the agent stores a call the
 * person allowed: running, in round 0.
 *
 * @param replyParts - Stores the call.
 * @param delegating - The delegating turn, whose reply makes the call.
 * @param request - What the call asks.
 * @returns The frozen draft, carrying the stored call's identity.
 * @throws If the turn's reply is no longer streaming or stored.
 */
export function createJobMessageDraft(
  replyParts: Pick<ReplyPartWriter, "createReplyPart">,
  delegating: TurnDelegationContext,
  request: JobMessageRequest
): JobMessageDraft {
  const part = replyParts.createReplyPart(delegating.turn.assistantMessage.id, {
    kind: "tool-call",
    id: uuidv7(),
    round: 0,
    toolName: DELEGATE_WORK_TOOL_NAME,
    argumentText: "{}",
    decision: ASK_ME_TOOL_CALL_DECISION,
    status: "running"
  })
  if (part === undefined)
    throw new Error("The reply took no delegate_work call")
  return Object.freeze({
    agentCode: request.agentCode,
    title: request.title,
    instructions: request.instructions,
    jobNumber: request.jobNumber,
    toolCallId: part.id
  })
}

/**
 * Sends a job message from a delegating turn, for a case that needs a job
 * before its action.
 *
 * @param services - The case's runtime and conversation services.
 * @param delegating - The delegating turn, whose reply makes the call.
 * @param request - What the call asks.
 * @returns The job the message went to, as stored right after; its reply
 * is running until the case ends it.
 * @throws If the message is refused, or its job cannot be read back.
 */
export function sendJobMessage(
  services: Pick<DelegationTestServices, "runtime" | "conversation">,
  delegating: TurnDelegationContext,
  request: JobMessageRequest
): Job {
  const draft = createJobMessageDraft(
    services.conversation.replyParts,
    delegating,
    request
  )
  const outcome = createJobMessage(services.runtime, delegating, draft)
  if (outcome.status === "refused")
    throw new Error(`The job message was refused: ${outcome.refusal.kind}`)
  const job = services.runtime.jobs.findJobByNumber(
    delegating.turn.conversation.id,
    outcome.jobNumber
  )
  if (job === undefined) throw new Error("The sent job is not stored")
  return job
}

/**
 * Lists the three delegation hooks of a turn start's options or of a
 * runtime, so a case can tell whether a turn was started with a runtime's
 * own hooks.
 *
 * @param hooks - The options or the runtime.
 * @returns `handleTurnStarted`, `createTurnDelegation`, and
 * `handleReplyEnded`, in that order; comparing two lists compares each hook
 * by identity.
 */
export function listTurnHooks(
  hooks: Pick<
    StartTurnOptions,
    "handleTurnStarted" | "createTurnDelegation" | "handleReplyEnded"
  >
): readonly unknown[] {
  return [
    hooks.handleTurnStarted,
    hooks.createTurnDelegation,
    hooks.handleReplyEnded
  ]
}

/**
 * Waits until the reply of the first job of a main conversation ended, for
 * a case whose job's turn runs through a real turn start.
 *
 * @param services - Reads the main conversation, which lists its jobs, and
 * holds the job's reply generation while it runs.
 * @param conversationId - UUIDv7 of the stored main conversation.
 * @returns The job as stored once its reply's generation settled, or right
 * away when no generation of the reply is registered.
 * @throws If the conversation is not stored or has no job.
 */
export async function waitForFirstJobReplyEnd(
  services: JobReplyServices,
  conversationId: string
): Promise<Job> {
  const job = findFirstJob(services.conversationHistoryReader, conversationId)
  const target: ReplyTarget = Object.freeze({
    conversationId: job.id,
    assistantMessageId: job.replyId
  })
  await services.replyGenerations.findReplyGeneration(target)?.settled
  return findFirstJob(services.conversationHistoryReader, conversationId)
}

/**
 * Finds the first job of a main conversation.
 *
 * @param reader - Reads the main conversation.
 * @param conversationId - UUIDv7 of the main conversation.
 * @returns The job numbered first, as stored now.
 * @throws If the conversation is not stored or has no job.
 */
export function findFirstJob(
  reader: ConversationReader,
  conversationId: string
): Job {
  const job = reader.getConversation(conversationId)?.jobs.at(0)
  if (job === undefined) throw new Error("The conversation has no job")
  return job
}
