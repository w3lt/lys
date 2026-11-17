import type { LoggerInterface } from "@lmstudio/sdk"
import type { ToolDefinition } from "@lys/share"
import type { FastifyBaseLogger } from "fastify"
import type { EmailAddress, LlmProvider } from "@lys/share"
import { homedir } from "node:os"
import type { BackendConfig } from "../config"
import SqliteAgentRecordStore from "../infrastructure/database/agents/sqliteAgentRecordStore"
import SqliteJobActivityReader from "../infrastructure/database/delegation/sqliteJobActivityReader"
import SqliteJobReader from "../infrastructure/database/delegation/sqliteJobReader"
import SqliteJobReportWriter from "../infrastructure/database/delegation/sqliteJobReportWriter"
import AttachmentFileStore from "../modules/attachment/attachmentFileStore"
import SqliteDatabase from "../infrastructure/database/sqliteDatabase"
import { acquireLlmProviderRuntime } from "../modules/llm/runtimes/llmProviderRuntime"
import ActivityHub from "../modules/activity/activityHub"
import AgentRuntimeService, {
  buildConversationTitleLookup
} from "../modules/agent/agentRuntimeService"
import AgentService from "../modules/agent/agentService"
import { buildBuiltInAgents } from "../modules/agent/builtInAgents"
import { buildListedDelegationDefinitions } from "../modules/agent/delegationTools"
import ChatService, {
  type ChatServiceCreationOptions
} from "../modules/chat/chatService"
import LlmReplyContextMeter from "../modules/chat/llmReplyContextMeter"
import OpenAiReplyModel from "../modules/chat/openAiReplyModel"
import ReplyGenerationRegistry from "../modules/chat/replyGenerationRegistry"
import type { StopReply } from "../modules/chat/replyStop"
import {
  startTurn,
  type StartTurn,
  type StartTurnOptions,
  type TurnStartDependencies
} from "../modules/chat/turnStart"
import SqliteConversationRecordEditor from "../infrastructure/database/conversations/sqliteConversationRecordEditor"
import SqliteConversationRecordReader from "../infrastructure/database/conversations/sqliteConversationRecordReader"
import SqliteConversationTurnRecordWriter from "../infrastructure/database/conversations/sqliteConversationTurnRecordWriter"
import SqliteReplyPartRecordWriter from "../infrastructure/database/conversations/sqliteReplyPartRecordWriter"
import type {
  ListWorkingReplies,
  StopDeletedReplies
} from "../modules/conversation/capabilities"
import SqliteToolSearchCallRecordWriter from "../infrastructure/database/conversations/sqliteToolSearchCallRecordWriter"
import StoredConversationHistoryEditor from "../modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../modules/conversation/historyReader"
import StoredReplyParts from "../modules/conversation/replyParts"
import StoredConversationTurns from "../modules/conversation/turns"
import {
  listWorkingReplies,
  stopDeletedReplies
} from "../modules/delegation/conversationDeletions"
import ConversationWakeSettings from "../modules/delegation/conversationWakeSettings"
import type { DelegationEvent } from "../modules/delegation/delegationEvent"
import { createDelegationRuntime } from "../modules/delegation/delegationRuntime"
import {
  stopConversationJobs,
  stopReplyForPerson
} from "../modules/delegation/jobStops"
import ReplyStopRequests from "../modules/delegation/replyStopRequests"
import LlmRuntimeService, {
  type LlmRuntimeFailureReporters
} from "../modules/llm/llmRuntimeService"
import LlmService from "../modules/llm/llmService"
import { buildLlmChatEndpoint } from "../modules/llm/llmProviderAccess"
import {
  buildLlmProviderRecord,
  type LlmProviderRecord,
  type LlmProviderServices
} from "../modules/llm/llmProviderServices"
import { findLlmProviderAccess } from "../infrastructure/settings/llmProviderSettingsFile"
import ToolApprovalService from "../modules/toolApproval/toolApprovalService"
import {
  buildApprovedFolders,
  type ToolCallPolicy
} from "../modules/toolApproval/toolCallPolicy"
import { readApprovedFolders } from "../infrastructure/settings/approvedFoldersFile"
import { readJustRunToolNames } from "../infrastructure/settings/justRunToolsFile"
import { readEmailAccounts } from "../infrastructure/settings/emailAccountFile"
import { readMcpSettings } from "../infrastructure/settings/mcpSettingsFile"
import { readTavilyApiKey } from "../infrastructure/settings/tavilyApiKeyFile"
import type { BuiltInToolEntry } from "../modules/tool/builtIn/builtInTool"
import {
  buildTavilyRequestDependencies,
  createBuiltInTools
} from "../modules/tool/builtIn/builtInTools"
import type { PageRenderingFailureReporters } from "../modules/tool/builtIn/web/pageRendering"
import WebSearchToolProvider from "../modules/tool/builtIn/web/webSearchToolProvider"
import EmailAccountChecker, {
  type EmailAccountCheckEvent
} from "../modules/mcp/builtIn/email/emailAccountCheck"
import {
  buildEmailServerCommand,
  EmailMcpServer
} from "../modules/mcp/builtIn/email/emailServer"
import type { McpServerEvent } from "../modules/mcp/mcpServerEvent"
import McpServerProcessGroups from "../modules/mcp/mcpServerProcessGroups"
import McpServerRegistry from "../modules/mcp/mcpServerRegistry"
import { MCP_SERVER_OPENING_TIMEOUT_MILLISECONDS } from "../modules/mcp/mcpServerConnection"
import { openMcpServer } from "../modules/mcp/mcpServerOpening"

/** Private close operation owned by one returned singleton-service bundle. */
const CLOSE_SINGLETON_SERVICES = Symbol("close-singleton-services")

/** Closes all resources owned by one singleton-service bundle. */
type CloseSingletonServices = () => Promise<void>

/** One newly acquired service or resource owner paired with its exclusive cleanup capability. */
export type SingletonServiceAcquisition<Service> = Readonly<{
  /** Acquired value whose cleanup the singleton bundle takes over. */
  service: Service
  /** Releases every resource exclusively owned by the service. */
  closeService: () => Promise<void>
}>

/** What creating one provider's LLM runtime service takes. */
export type LlmRuntimeServiceFactoryOptions = Readonly<{
  /** Provider the service connects to. */
  provider: LlmProvider
  /**
   * Settings file read, at every connection attempt, for whether the
   * provider is on, its address, and its key.
   */
  settingsFilePath: BackendConfig["settingsFilePath"]
  /** Receive the provider's runtime failures that no caller observes. */
  llmRuntimeFailureReporters: LlmRuntimeFailureReporters
  /** Receives the messages of each acquired LM Studio SDK client. */
  lmStudioSdkLogger: LoggerInterface
}>

/** Factories for the independently created application services and the database they share. */
export type SingletonServiceFactories = Readonly<{
  /**
   * Creates the chat service for each connected provider's
   * OpenAI-compatible endpoint and its title settings.
   */
  createChatService: (
    options: ChatServiceCreationOptions
  ) => SingletonServiceAcquisition<ChatService>
  /** Opens the shared backend database at one location. */
  createDatabase: (
    databaseFilePath: BackendConfig["databaseFilePath"]
  ) => SingletonServiceAcquisition<SqliteDatabase>
  /**
   * Creates the owned LLM runtime service of one provider, without reading
   * the settings file or contacting the provider.
   */
  createLlmRuntimeService: (
    options: LlmRuntimeServiceFactoryOptions
  ) => SingletonServiceAcquisition<LlmRuntimeService>
}>

/**
 * Receive, for logging, what the services report that no caller observes in
 * full: their failures, the LM Studio SDK's own messages, and what
 * delegation does, with the logger of the turns the backend starts itself.
 */
export type SingletonLogReporters = Readonly<{
  /**
   * Receive, for each provider, the LLM runtime failures that no caller
   * observes.
   */
  llmRuntime: LlmProviderRecord<LlmRuntimeFailureReporters>
  /** Receive the causes of read failures the model learns only by kind. */
  pageRendering: PageRenderingFailureReporters
  /**
   * Receives the messages of every LM Studio SDK client, such as why it
   * could not connect.
   */
  lmStudioSdk: LoggerInterface
  /**
   * Receives what the MCP servers do that no caller observes, such as a
   * failed connection or a server's own log lines.
   */
  reportMcpServerEvent: (event: McpServerEvent) => void
  /**
   * Receives each failure to save the MCP servers' process groups file,
   * after which the desktop host may not end a server that a killed
   * backend left running.
   */
  reportMcpProcessGroupsSaveFailure: (failure: Error) => void
  /**
   * Receives the outcome of each email account check and why a check did
   * not report, without the account or the password.
   */
  sendEmailAccountCheckEvent: (event: EmailAccountCheckEvent) => void
  /**
   * Receives what delegation does that no caller observes, such as a job
   * message sent or refused, or a job asked to stop.
   */
  reportDelegationEvent: (event: DelegationEvent) => void
  /**
   * Logger of the turns the backend starts itself, such as a job's turn,
   * which no request logs.
   */
  backendTurnLogger: FastifyBaseLogger
}>

/** Production factories used when the composition root supplies no substitutes. */
const DEFAULT_SINGLETON_SERVICE_FACTORIES = Object.freeze({
  createChatService,
  createDatabase,
  createLlmRuntimeService
} satisfies SingletonServiceFactories)

/** Application-scoped services owned for a Fastify application's lifetime. */
export type SingletonServices = Readonly<{
  /**
   * Chat completion adapter that sends each request to the endpoint of the
   * provider its model is on.
   */
  chatService: ChatService
  /**
   * Each provider's runtime connection and model-operation queue, owned by
   * the application, and its model policy served through that queue.
   */
  llmProviderServices: LlmProviderRecord<LlmProviderServices>
  /** Turn persistence over the shared database; it owns nothing to release. */
  conversationTurns: StoredConversationTurns
  /**
   * Reply-part and source persistence over the shared database; it owns
   * nothing to release.
   */
  replyParts: StoredReplyParts
  /** History reading over the shared database; it owns nothing to release. */
  conversationHistoryReader: StoredConversationHistoryReader
  /** History editing over the shared database; it owns nothing to release. */
  conversationHistoryEditor: StoredConversationHistoryEditor
  /**
   * The built-in agents and agent definitions over agent records on the
   * shared database; it owns nothing to release.
   */
  agentService: AgentService
  /**
   * The live agents, which answer over the chat service and measure through
   * the LLM service, and what agents may learn about each other; its live
   * agents own nothing to release.
   */
  agentRuntimeService: AgentRuntimeService
  /**
   * Every built-in tool, in the order Settings lists them; they own nothing
   * to release.
   */
  builtInTools: readonly BuiltInToolEntry[]
  /**
   * Definitions of the agent tools Settings lists after the built-in tools:
   * `delegate_work` only, since the other delegation tools have no switch.
   */
  listedAgentTools: readonly ToolDefinition[]
  /**
   * Finds the web search tool for each turn and checks the saved Tavily
   * key; it owns nothing to release.
   */
  webSearchToolProvider: WebSearchToolProvider
  /**
   * Decides which tool calls ask the person first, from the Just run
   * choices saved in the settings file; it owns nothing to release.
   */
  toolApprovalService: ToolApprovalService
  /**
   * Connections to the MCP servers the settings file names, and their
   * tools; the bundle's cleanup closes it once every reply generation has
   * ended, after the email account checker and before the services acquired
   * earlier.
   */
  mcpServerRegistry: McpServerRegistry
  /**
   * The process groups the registry's stdio servers run in, which the
   * backend ends at once when it exits; it owns no process, only their
   * identifiers and the MCP process groups file it saves them to.
   */
  mcpServerProcessGroups: McpServerProcessGroups
  /**
   * Checks of email accounts through the email server Lys ships, one at a
   * time; the bundle's cleanup kills the running check.
   */
  emailAccountChecker: EmailAccountChecker
  /**
   * Attachment files of every conversation, under the attachments
   * directory; it owns nothing to release.
   */
  attachmentFileStore: AttachmentFileStore
  /**
   * Every running reply generation, registered by the turn start; the
   * bundle's cleanup disposes it right after it disposed of the activity
   * hub, which ends every generation.
   */
  replyGenerations: ReplyGenerationRegistry
  /**
   * Starts the generation of one stored turn in the registry, over the
   * conversation services, the chat service and each provider's LLM
   * service, the tool call policy, the tool approval service, and the
   * attachment file store; it owns nothing to release.
   */
  startTurn: StartTurn
  /**
   * The open activity streams and the backend-started replies they follow;
   * the bundle's cleanup disposes of it right after the wake settings, which
   * ends every activity stream before the generations end.
   */
  activityHub: ActivityHub
  /**
   * The settings each main conversation's wake-up turns start with, which
   * delegation remembers while a job of the conversation works; it owns
   * nothing to release. The bundle's cleanup closes it first, so a reply
   * that ends while the generations end starts no wake-up turn.
   */
  conversationWakeSettings: ConversationWakeSettings
  /**
   * Hook through which each person's turn takes part in delegation, told
   * that the turn starts, over the job records on the shared database, the
   * agent services, the turn start, and the activity hub; it owns nothing
   * to release.
   */
  handleTurnStarted: StartTurnOptions["handleTurnStarted"]
  /**
   * Hook that creates each person's turn's part in delegation, over the
   * same services; it owns nothing to release.
   */
  createTurnDelegation: StartTurnOptions["createTurnDelegation"]
  /**
   * Hook told that the reply of each person's turn ended, over the same
   * services; it owns nothing to release.
   */
  handleReplyEnded: StartTurnOptions["handleReplyEnded"]
  /**
   * Stops a reply for the person, with every working job below its
   * conversation, as delegation's runtime stops replies; it owns nothing to
   * release.
   */
  stopReply: StopReply
  /**
   * Stops every working job below a conversation for the person, as
   * delegation's runtime stops replies, and resolves once each stopped reply
   * reached its stored final state; it owns nothing to release.
   */
  stopConversationJobs: (conversationId: string) => Promise<void>
  /**
   * Lists the working replies of a conversation and of its jobs before the
   * conversation is deleted, as delegation's runtime finds them; it owns
   * nothing to release.
   */
  listWorkingReplies: ListWorkingReplies
  /**
   * Cancels the work listed before a conversation was deleted, once the
   * delete succeeded, as delegation's runtime ends generations; it owns
   * nothing to release.
   */
  stopDeletedReplies: StopDeletedReplies
  /** Module-private cleanup capability for the complete owned service lifetime. */
  [CLOSE_SINGLETON_SERVICES]: CloseSingletonServices
}>

/**
 * What starts turns: the registry of the running reply generations, which
 * the bundle disposes, and the turn start bound to it.
 */
type TurnStartServices = Pick<
  SingletonServices,
  "replyGenerations" | "startTurn"
>

/**
 * What delegation adds to a bundle: its wake settings, its hooks, the
 * person's stops, and what a deletion lists and cancels.
 */
type DelegationServices = Pick<
  SingletonServices,
  | "conversationWakeSettings"
  | "handleTurnStarted"
  | "createTurnDelegation"
  | "handleReplyEnded"
  | "stopReply"
  | "stopConversationJobs"
  | "listWorkingReplies"
  | "stopDeletedReplies"
>

/**
 * The services a bundle's turn start is created over: every service of the
 * bundle except the turn start, its registry, the activity hub, and
 * delegation's.
 */
type CoreServices = Omit<
  SingletonServices,
  | keyof TurnStartServices
  | "activityHub"
  | keyof DelegationServices
  | typeof CLOSE_SINGLETON_SERVICES
>

/**
 * The services {@link buildCoreServices} writes out by name, as their
 * creation groups them.
 */
type CoreServiceGroups = Readonly<{
  /** Chat service the bundle holds. */
  chatService: CoreServices["chatService"]
  /** Each provider's LLM services. */
  llmProviderServices: CoreServices["llmProviderServices"]
  /** Services that keep their data in the shared database. */
  databaseServices: DatabaseServices
  /** Services that define agents and run them. */
  agentServices: AgentServices
  /** Services that run, find, and approve tools. */
  toolServices: ToolServices
  /** Store of the attachment files of every conversation. */
  attachmentFileStore: CoreServices["attachmentFileStore"]
}>

/** What a bundle is created with, besides the services it holds. */
type SingletonBundleContext = Readonly<{
  /**
   * Title attempt limit and settings file given to the turn start, and job
   * message limit given to delegation.
   */
  config: Pick<
    BackendConfig,
    "titleGenerationMaxAttempts" | "settingsFilePath" | "agentJobMessageLimit"
  >
  /**
   * Receive delegation's events, and log the turns the backend starts
   * itself.
   */
  logReporters: Pick<
    SingletonLogReporters,
    "reportDelegationEvent" | "backendTurnLogger"
  >
  /**
   * Owner of every service the bundle acquired; it takes over the disposal
   * of the reply generation registry, then that of the activity hub, then
   * the close of delegation's wake settings, so it closes the wake settings
   * first, then disposes of the hub, then of the registry, before
   * everything it took over earlier.
   */
  serviceLifetime: AsyncDisposableStack
  /**
   * Shared database lent to delegation's job records; the caller keeps
   * ownership and closes it.
   */
  database: SqliteDatabase
}>

/**
 * Services that run, find, and approve tools; only the MCP server registry
 * and the email account checker own resources.
 */
type ToolServices = Pick<
  SingletonServices,
  | "builtInTools"
  | "listedAgentTools"
  | "webSearchToolProvider"
  | "toolApprovalService"
  | "mcpServerRegistry"
  | "mcpServerProcessGroups"
  | "emailAccountChecker"
>

/**
 * The tool services, and the reader of Lys's own email address that the
 * agent runtime service borrows from them.
 */
type CreatedToolServices = Readonly<{
  /** Services that run, find, and approve tools. */
  services: ToolServices
  /**
   * Reads the address of Lys's own mailbox while the built-in email server
   * serves it, or null.
   */
  readLysEmailAddress: () => EmailAddress | null
}>

/** Services that keep their data in the shared database and own nothing. */
type DatabaseServices = Pick<
  SingletonServices,
  | "conversationTurns"
  | "replyParts"
  | "conversationHistoryReader"
  | "conversationHistoryEditor"
>

/**
 * Creates the application-scoped service bundle from backend network configuration.
 *
 * @param config - Settings file each provider's LLM runtime service reads
 * whether its provider is on from, the title-generation prompt and title
 * length limit given to
 * the chat service, the built-in agents' system prompts given to the agent service,
 * vmo's host and port given to the read-page tool, the attachments
 * directory given to the attachment file store, the MCP process groups
 * file given to the holder of the MCP servers' process groups, the email
 * server's path given to the built-in email server and the email account
 * checker, the title attempt limit and the settings file's approved folders
 * given to the turn start, and the job message limit given to delegation.
 * @param logReporters - Receive, for logging, each provider's LLM runtime
 * failures that no caller observes, the causes of read failures the model
 * learns only by
 * kind, the LM Studio SDK's messages, the MCP servers' events, the
 * failures to save their process groups file, the email account checks,
 * and delegation's events; and the logger of the turns the backend starts
 * itself.
 * @param factories - Service factories owned by the composition root.
 * @returns A promise resolving to the frozen bundle of owned services. No
 * service reads the settings file or contacts a provider during creation;
 * each provider's runtime service connects later, and the chat service sends
 * each request to the endpoint its model's provider is connected at when the
 * request starts.
 * @throws The original construction failure, after every resource acquired
 * before it is closed.
 * @throws {AggregateError} If closing the acquired resources also fails; its
 * errors hold the construction failure followed by the cleanup failure.
 * @remarks Resources are acquired in the order database, the LLM runtime
 * services in provider order, chat service; the chat service comes after the
 * runtime services because it reads the connected providers from them. Each
 * provider's LLM service is created over its own runtime service and owns
 * nothing to release. The conversation services
 * and the Sqlite records they wrap are created over the database before the
 * runtime services, turn persistence first, so its startup recovery runs
 * before any history is read. The agent service and the agent runtime
 * service are created after the chat service: the agent service over its
 * Sqlite records, and the runtime service over the agent service, the chat
 * service, the providers' LLM services, and the history reader; they read
 * nothing at creation and own nothing to release.
 * The web search tool provider, the built-in tools, the listed agent tools,
 * the tool approval service, the MCP server registry, the email account
 * checker, and the attachment file store are created next; they read and
 * contact nothing at creation. The reply generation registry and the turn
 * start, with the tool call policy, are created next, over the services
 * before them, then the activity hub, and last delegation's wake settings,
 * stop requests, and job records, over the database, with the hooks of its
 * runtime and the person's stops over the services before them; they read
 * nothing at creation and own nothing to release. Only the MCP server
 * registry, the email account checker, the reply generation registry, and
 * the activity hub own resources: the connections and the check process the
 * first two open later, the generations the turn start starts later, and
 * the activity streams clients open later. The bundle's cleanup closes
 * delegation's wake settings first, so no wake-up turn starts any more,
 * then disposes of the activity hub, which ends every activity stream, then
 * of the reply generation registry, which ends every generation, then
 * closes the email account checker, then the MCP server registry. Creation
 * stops at the first failure. The database is not part of the returned
 * bundle: the bundle's cleanup closes it last, after the chat service and
 * the LLM runtime services; it attempts every close even when one fails,
 * and keeps every failure.
 */
export async function createSingletonServices(
  config: BackendConfig,
  logReporters: SingletonLogReporters,
  factories: SingletonServiceFactories = DEFAULT_SINGLETON_SERVICE_FACTORIES
): Promise<SingletonServices> {
  const serviceLifetime = new AsyncDisposableStack()

  try {
    const { database, services: databaseServices } = acquireDatabaseServices(
      config,
      factories,
      serviceLifetime
    )

    const llmProviderServices = buildLlmProviderRecord((provider) =>
      createOwnedLlmProviderServices(provider, {
        config,
        logReporters,
        factories,
        serviceLifetime
      })
    )

    const chatServiceAcquisition = factories.createChatService(
      buildChatServiceOptions(config, llmProviderServices)
    )
    serviceLifetime.defer(chatServiceAcquisition.closeService)
    const chatService = chatServiceAcquisition.service

    const tools = createToolServices(config, logReporters)
    serviceLifetime.defer(buildCloseToolServices(tools.services))
    const agentServices = createAgentServices(config, database, {
      chatService,
      llmProviderServices,
      historyReader: databaseServices.conversationHistoryReader,
      readLysEmailAddress: tools.readLysEmailAddress
    })
    const attachmentFileStore = new AttachmentFileStore(
      config.attachmentsDirectoryPath
    )

    return createSingletonServiceBundle(
      { config, logReporters, serviceLifetime, database },
      buildCoreServices({
        chatService,
        llmProviderServices,
        databaseServices,
        agentServices,
        toolServices: tools.services,
        attachmentFileStore
      })
    )
  } catch (creationError) {
    return await throwCreationFailureAfterClosingResources(
      creationError,
      serviceLifetime,
      "Singleton service creation and cleanup both failed."
    )
  }
}

/**
 * Creates the turn start and its registry over a bundle's other services,
 * creates the activity hub and delegation's services, and builds the bundle.
 *
 * @param context - The limits, delegation's log reporters, the owner of
 * every service the bundle acquired, and the shared database.
 * @param coreServices - The bundle's other services, which the turn start
 * and delegation borrow for the bundle's lifetime.
 * @returns The frozen bundle of owned services, with its cleanup capability.
 */
function createSingletonServiceBundle(
  context: SingletonBundleContext,
  coreServices: CoreServices
): SingletonServices {
  const { config, serviceLifetime } = context
  const turnStartServices = createTurnStartServices(config, coreServices)
  serviceLifetime.use(turnStartServices.replyGenerations)
  const activityHub = new ActivityHub()
  serviceLifetime.use(activityHub)
  const delegationServices = createDelegationServices(context, {
    agentService: coreServices.agentService,
    agentRuntimeService: coreServices.agentRuntimeService,
    conversationHistoryReader: coreServices.conversationHistoryReader,
    conversationTurns: coreServices.conversationTurns,
    startTurn: turnStartServices.startTurn,
    replyGenerations: turnStartServices.replyGenerations,
    activityHub
  })
  serviceLifetime.defer(() => {
    delegationServices.conversationWakeSettings.close()
  })
  return Object.freeze({
    ...coreServices,
    replyGenerations: turnStartServices.replyGenerations,
    startTurn: turnStartServices.startTurn,
    activityHub,
    conversationWakeSettings: delegationServices.conversationWakeSettings,
    handleTurnStarted: delegationServices.handleTurnStarted,
    createTurnDelegation: delegationServices.createTurnDelegation,
    handleReplyEnded: delegationServices.handleReplyEnded,
    stopReply: delegationServices.stopReply,
    stopConversationJobs: delegationServices.stopConversationJobs,
    listWorkingReplies: delegationServices.listWorkingReplies,
    stopDeletedReplies: delegationServices.stopDeletedReplies,
    [CLOSE_SINGLETON_SERVICES]: buildCloseSingletonServices(serviceLifetime)
  })
}

/**
 * Writes the services of a bundle's groups out by name, as the services a
 * bundle's turn start is created over.
 *
 * @param groups - The chat service, each provider's LLM services, the
 * services over the shared database, the agent services, the tool services,
 * and the attachment file store.
 * @returns A new record of every one of those services; it holds the same
 * services and owns none of them.
 */
function buildCoreServices({
  chatService,
  llmProviderServices,
  databaseServices,
  agentServices,
  toolServices,
  attachmentFileStore
}: CoreServiceGroups): CoreServices {
  return {
    chatService,
    llmProviderServices,
    conversationTurns: databaseServices.conversationTurns,
    replyParts: databaseServices.replyParts,
    conversationHistoryReader: databaseServices.conversationHistoryReader,
    conversationHistoryEditor: databaseServices.conversationHistoryEditor,
    agentService: agentServices.agentService,
    agentRuntimeService: agentServices.agentRuntimeService,
    builtInTools: toolServices.builtInTools,
    listedAgentTools: toolServices.listedAgentTools,
    webSearchToolProvider: toolServices.webSearchToolProvider,
    toolApprovalService: toolServices.toolApprovalService,
    mcpServerRegistry: toolServices.mcpServerRegistry,
    mcpServerProcessGroups: toolServices.mcpServerProcessGroups,
    emailAccountChecker: toolServices.emailAccountChecker,
    attachmentFileStore
  }
}

/**
 * Creates what delegation remembers, its job records, the hooks of its
 * runtime, the person's stops, and what a deletion lists and cancels.
 *
 * @param context - The job message limit, delegation's log reporters, and
 * the shared database the job records read and write.
 * @param services - Services delegation borrows for the bundle's lifetime:
 * the agent service and the agent runtime service, which find and load
 * agents, the history reader and turn persistence, the turn start and its
 * registry, and the activity hub.
 * @returns The wake settings, the runtime's hooks, the person's stop of a
 * reply and of a conversation's jobs, and the listing and cancellation of a
 * deleted conversation's work, which call {@link listWorkingReplies} and
 * {@link stopDeletedReplies} with the runtime; they read and contact
 * nothing at creation and own nothing to release.
 */
function createDelegationServices(
  context: Pick<SingletonBundleContext, "config" | "logReporters" | "database">,
  services: Pick<
    SingletonServices,
    | "agentService"
    | "agentRuntimeService"
    | "conversationHistoryReader"
    | "conversationTurns"
    | "startTurn"
    | "replyGenerations"
    | "activityHub"
  >
): DelegationServices {
  const { config, logReporters, database } = context
  const { agentService, agentRuntimeService, conversationHistoryReader } =
    services
  const conversationWakeSettings = new ConversationWakeSettings()
  const stopRequests = new ReplyStopRequests()
  const jobs = new SqliteJobReader(database)
  const jobActivity = new SqliteJobActivityReader(database)
  const reports = new SqliteJobReportWriter(database)
  const runtime = createDelegationRuntime({
    findAgent: (code) => agentService.findAgent(code),
    loadChatAgent: (code) => agentRuntimeService.loadChatAgent(code),
    findConversationAgentCode: (conversationId) =>
      conversationHistoryReader.getConversationMetadata(conversationId)
        ?.agentCode,
    jobs,
    jobActivity,
    reports,
    turns: services.conversationTurns,
    startTurn: services.startTurn,
    generations: services.replyGenerations,
    hub: services.activityHub,
    wakeSettings: conversationWakeSettings,
    stopRequests,
    agentJobMessageLimit: config.agentJobMessageLimit,
    reportEvent: logReporters.reportDelegationEvent,
    logger: logReporters.backendTurnLogger
  })
  return {
    conversationWakeSettings,
    handleTurnStarted: runtime.handleTurnStarted,
    createTurnDelegation: runtime.createTurnDelegation,
    handleReplyEnded: runtime.handleReplyEnded,
    stopReply: (target) => stopReplyForPerson(runtime, target),
    stopConversationJobs: (conversationId) =>
      stopConversationJobs(runtime, conversationId),
    listWorkingReplies: (conversationId) =>
      listWorkingReplies(runtime, conversationId),
    stopDeletedReplies: (conversationId, replies) =>
      stopDeletedReplies(runtime, conversationId, replies)
  }
}

/**
 * Creates the registry of the running reply generations and the turn start
 * bound to it.
 *
 * @param config - Inclusive maximum number of title requests for one turn,
 * and the settings file the tool call policy reads the approved folders
 * from.
 * @param services - Services the turn start borrows for the bundle's
 * lifetime: turn, reply-part, and history persistence, the attachment file
 * store, the chat service that generates titles, each provider's LLM
 * service, which tells whether a model is loaded, and the tool approval
 * service.
 * @returns The registry, whose disposal the caller owns, and the turn start,
 * which registers every generation it starts with that registry and decides
 * its tool calls with the policy {@link createToolCallPolicy} creates; they
 * read and contact nothing at creation.
 */
function createTurnStartServices(
  config: Pick<
    BackendConfig,
    "titleGenerationMaxAttempts" | "settingsFilePath"
  >,
  services: Pick<
    SingletonServices,
    | "conversationTurns"
    | "replyParts"
    | "conversationHistoryReader"
    | "attachmentFileStore"
    | "chatService"
    | "llmProviderServices"
    | "toolApprovalService"
  >
): TurnStartServices {
  const { conversationTurns, conversationHistoryReader } = services
  const { chatService, llmProviderServices } = services
  const replyGenerations = new ReplyGenerationRegistry()
  const dependencies: TurnStartDependencies = {
    generations: replyGenerations,
    turns: conversationTurns,
    replyParts: services.replyParts,
    titleWriter: conversationTurns,
    findConversation: (conversationId) =>
      conversationHistoryReader.getConversation(conversationId),
    attachmentFiles: services.attachmentFileStore,
    generateTitle: (options) => chatService.generateTitle(options),
    findLoadedContextLength: async (model) =>
      (
        await llmProviderServices[
          model.provider
        ].llmService.findLlmContextMeasurement(model.modelKey, [])
      )?.contextLength,
    titleGenerationMaxAttempts: config.titleGenerationMaxAttempts,
    toolCallPolicy: createToolCallPolicy(config.settingsFilePath),
    toolApprovals: services.toolApprovalService
  }
  return {
    replyGenerations,
    startTurn: (options) => startTurn(dependencies, options)
  }
}

/**
 * Creates the tool call policy every turn's tool calls are decided by.
 *
 * @param settingsFilePath - Settings file the approved folders are read
 * from, at each read.
 * @returns A frozen policy with the settings file, this machine's home
 * folder, and a reader of the folders the person lets tools use; it reads
 * nothing at creation.
 */
function createToolCallPolicy(settingsFilePath: string): ToolCallPolicy {
  return Object.freeze({
    settingsFilePath,
    homeFolderPath: homedir(),
    readApprovedFolders: async () =>
      buildApprovedFolders(await readApprovedFolders(settingsFilePath))
  })
}

/**
 * What creating each provider's services takes from the service bundle that
 * owns them.
 */
type OwnedLlmProviderServicesCreationOptions = Readonly<{
  /** Settings file each provider's runtime service reads its provider from. */
  config: BackendConfig
  /**
   * Each provider's runtime failure reporters and the LM Studio SDK's
   * logger.
   */
  logReporters: Pick<SingletonLogReporters, "llmRuntime" | "lmStudioSdk">
  /** Creates each provider's runtime service. */
  factories: Pick<SingletonServiceFactories, "createLlmRuntimeService">
  /**
   * The bundle's owner of acquired services, which takes over each runtime
   * service's close.
   */
  serviceLifetime: Pick<AsyncDisposableStack, "defer">
}>

/**
 * Creates one provider's runtime service and LLM service, and hands the
 * runtime service's close to the bundle that owns them.
 *
 * @param provider - Provider whose services are created.
 * @param options - Settings file and log reporters the runtime service is
 * created with, its factory, and the bundle's owner of acquired services.
 * @returns The runtime service and the LLM service over it; the bundle's
 * owner closes the runtime service, and the LLM service owns nothing to
 * release.
 * @throws The factory's failure; the provider then has nothing for the
 * owner to close.
 */
function createOwnedLlmProviderServices(
  provider: LlmProvider,
  {
    config,
    logReporters,
    factories,
    serviceLifetime
  }: OwnedLlmProviderServicesCreationOptions
): LlmProviderServices {
  const acquisition = factories.createLlmRuntimeService(
    buildLlmRuntimeServiceFactoryOptions(provider, config, logReporters)
  )
  serviceLifetime.defer(acquisition.closeService)
  return createLlmProviderServices(acquisition.service)
}

/**
 * Builds what creating one provider's LLM runtime service takes.
 *
 * @param provider - Provider the service connects to.
 * @param config - Settings file the service reads the provider from.
 * @param logReporters - The provider's runtime failure reporters and the
 * LM Studio SDK's logger.
 * @returns The provider, the settings file, the provider's own failure
 * reporters, and the shared LM Studio SDK logger.
 */
function buildLlmRuntimeServiceFactoryOptions(
  provider: LlmProvider,
  config: BackendConfig,
  logReporters: Pick<SingletonLogReporters, "llmRuntime" | "lmStudioSdk">
): LlmRuntimeServiceFactoryOptions {
  return Object.freeze({
    provider,
    settingsFilePath: config.settingsFilePath,
    llmRuntimeFailureReporters: logReporters.llmRuntime[provider],
    lmStudioSdkLogger: logReporters.lmStudioSdk
  })
}

/**
 * Creates one provider's LLM service over its runtime service.
 *
 * @param llmRuntimeService - The provider's runtime service; the caller
 * keeps ownership and closes it.
 * @returns The runtime service and the LLM service whose model operations
 * go through its queue; the LLM service owns nothing to release.
 */
function createLlmProviderServices(
  llmRuntimeService: LlmRuntimeService
): LlmProviderServices {
  return Object.freeze({
    llmRuntimeService,
    llmService: new LlmService({ llmEngineOperationQueue: llmRuntimeService })
  })
}

/**
 * Builds the settings the chat service is created with.
 *
 * @param config - Title-generation prompt and title length limit.
 * @param llmProviderServices - Each provider's runtime service, whose
 * connected provider the chat requests for that provider's models go to;
 * borrowed for the chat service's lifetime.
 * @returns A lookup of one provider's OpenAI-compatible endpoint, undefined
 * while that provider is not connected, and the title settings.
 */
function buildChatServiceOptions(
  config: BackendConfig,
  llmProviderServices: LlmProviderRecord<LlmProviderServices>
): ChatServiceCreationOptions {
  return {
    findChatEndpoint: (provider) => {
      const access =
        llmProviderServices[provider].llmRuntimeService
          .connectedLlmProviderAccess
      return access === undefined ? undefined : buildLlmChatEndpoint(access)
    },
    titleGenerationPrompt: config.titleGenerationPrompt,
    generatedTitleMaxLength: config.generatedTitleMaxLength
  }
}

/** Services the live agents borrow, lent for the runtime service's lifetime. */
type AgentRuntimeDependencies = Readonly<{
  /** Chat service the agents answer through. */
  chatService: ChatService
  /**
   * Each provider's LLM service, which measures each context against the
   * model loaded on that provider.
   */
  llmProviderServices: LlmProviderRecord<LlmProviderServices>
  /** History reader that gives the titles of the agents' conversations. */
  historyReader: StoredConversationHistoryReader
  /**
   * Reads the address of Lys's own mailbox while it is in use, which
   * Caliginia and Lysiptera are told.
   */
  readLysEmailAddress: () => EmailAddress | null
}>

/** Services that define agents and run them; they own nothing to release. */
type AgentServices = Pick<
  SingletonServices,
  "agentService" | "agentRuntimeService"
>

/**
 * Creates the agent service over the shared database, and the agent runtime
 * service over it and the services the live agents borrow.
 *
 * @param config - System prompts of the built-in agents, and the request
 * slots and waiting limit every live agent gets.
 * @param database - Shared database lent to the agent records; the caller
 * keeps ownership and closes it.
 * @param dependencies - Chat service the agents answer through, the
 * providers' LLM services they measure through, the history reader that
 * titles their conversations, and the reader of Lys's own email address.
 * @returns Both services, which read nothing at creation and own nothing to
 * release.
 */
function createAgentServices(
  config: BackendConfig,
  database: SqliteDatabase,
  {
    chatService,
    llmProviderServices,
    historyReader,
    readLysEmailAddress
  }: AgentRuntimeDependencies
): AgentServices {
  const agentService = new AgentService({
    recordStore: SqliteAgentRecordStore.create(database),
    builtInAgents: buildBuiltInAgents({
      caliginia: config.caliginiaSystemPrompt,
      lysiptera: config.lysipteraSystemPrompt,
      armitage: config.armitageSystemPrompt
    })
  })
  return {
    agentService,
    agentRuntimeService: new AgentRuntimeService({
      agents: agentService,
      replyModel: new OpenAiReplyModel((options) =>
        chatService.completeChatStream(options)
      ),
      replyContextMeter: new LlmReplyContextMeter((model, texts) =>
        llmProviderServices[
          model.provider
        ].llmService.findLlmContextMeasurement(model.modelKey, texts)
      ),
      findConversationTitle: (conversationId) =>
        buildConversationTitleLookup(
          historyReader.getConversation(conversationId)
        ),
      requestLimits: Object.freeze({
        slotCount: config.agentRequestSlotCount,
        waitingLimit: config.agentWaitingRequestLimit
      }),
      toolSearchCallRecords: new SqliteToolSearchCallRecordWriter(database),
      readLysEmailAddress
    })
  }
}

/**
 * Creates the services that run, find, and approve tools.
 *
 * @param config - Settings file the web search key, the Just run choices,
 * the MCP servers, and the email account are read from, vmo's host and
 * port given to the read-page tool, the file the MCP servers' process
 * groups are saved to, and the path of the email server Lys ships.
 * @param logReporters - Receive the causes of read failures the model
 * learns only by kind, the MCP servers' events, the failures to save
 * their process groups file, and the email account checks.
 * @returns The web search tool provider, every built-in tool, the
 * definitions of the agent tools Settings lists, the tool approval
 * service, the MCP server registry, whose stdio servers start in
 * the person's home folder and whose only built-in server is the email
 * server, the holder of those servers' process groups, which the registry
 * borrows, and the email account checker, which runs the same email
 * server; they read and contact nothing at creation. With them, the reader
 * of the address of Lys's own mailbox, which asks the email server and the
 * registry's list each time.
 */
function createToolServices(
  config: BackendConfig,
  logReporters: Pick<
    SingletonLogReporters,
    | "pageRendering"
    | "reportMcpServerEvent"
    | "reportMcpProcessGroupsSaveFailure"
    | "sendEmailAccountCheckEvent"
  >
): CreatedToolServices {
  /**
   * Longest one check may run before its process is killed: past two
   * sign-ins that each wait the email server's own connect and answer limits.
   */
  const emailAccountCheckTimeoutMilliseconds = 60_000

  const webSearchToolProvider = new WebSearchToolProvider(
    () => readTavilyApiKey(config.settingsFilePath),
    buildTavilyRequestDependencies()
  )
  const builtInTools = createBuiltInTools(
    webSearchToolProvider,
    `http://${config.vmoHost}:${config.vmoPort}`,
    logReporters.pageRendering.reportPageReaderFailure
  )
  const toolApprovalService = new ToolApprovalService(() =>
    readJustRunToolNames(config.settingsFilePath)
  )
  const mcpServerProcessGroups = new McpServerProcessGroups(
    config.mcpProcessGroupsFilePath,
    logReporters.reportMcpProcessGroupsSaveFailure
  )
  const emailServerCommand = buildEmailServerCommand(config.emailServerPath)
  const emailMcpServer = new EmailMcpServer(emailServerCommand, () =>
    readEmailAccounts(config.settingsFilePath)
  )
  const mcpWorkingDirectory = homedir()
  const mcpServerRegistry = new McpServerRegistry({
    readSettings: () => readMcpSettings(config.settingsFilePath),
    builtInServers: [emailMcpServer],
    openServer: (settings, context) =>
      openMcpServer(settings, context, MCP_SERVER_OPENING_TIMEOUT_MILLISECONDS),
    workingDirectory: mcpWorkingDirectory,
    processGroups: mcpServerProcessGroups,
    reportEvent: logReporters.reportMcpServerEvent
  })
  const emailAccountChecker = new EmailAccountChecker({
    serverCommand: emailServerCommand,
    workingDirectory: mcpWorkingDirectory,
    timeoutMilliseconds: emailAccountCheckTimeoutMilliseconds,
    sendEvent: logReporters.sendEmailAccountCheckEvent
  })
  return {
    services: {
      builtInTools,
      listedAgentTools: buildListedDelegationDefinitions(),
      webSearchToolProvider,
      toolApprovalService,
      mcpServerRegistry,
      mcpServerProcessGroups,
      emailAccountChecker
    },
    readLysEmailAddress: () =>
      emailMcpServer.readLysEmailAddress(mcpServerRegistry.listServers())
  }
}

/**
 * Builds the close operation of the tool services that own resources.
 *
 * @param toolServices - The MCP server registry and the email account
 * checker, of which the operation calls only `close`; the caller hands it
 * their cleanup.
 * @returns An operation that closes the email account checker, then the
 * MCP server registry, and settles once both closes settled. It attempts
 * both even when the first fails, and rejects with the failure, or with a
 * `SuppressedError` whose `error` is the registry's and whose `suppressed`
 * is the checker's.
 */
function buildCloseToolServices(
  toolServices: Readonly<{
    mcpServerRegistry: Pick<McpServerRegistry, "close">
    emailAccountChecker: Pick<EmailAccountChecker, "close">
  }>
): () => Promise<void> {
  const toolServicesLifetime = new AsyncDisposableStack()
  toolServicesLifetime.defer(() => toolServices.mcpServerRegistry.close())
  toolServicesLifetime.defer(() => toolServices.emailAccountChecker.close())
  return () => toolServicesLifetime.disposeAsync()
}

/** The shared database, and the services that keep their data in it. */
type AcquiredDatabase = Readonly<{
  /** The database, whose close the service lifetime owns. */
  database: SqliteDatabase
  /** The services over it, which own nothing to release. */
  services: DatabaseServices
}>

/**
 * Opens the shared database, hands its close to the service lifetime, and
 * creates the conversation services over it.
 *
 * @param config - Location of the database file.
 * @param factories - Opens the database.
 * @param serviceLifetime - Lifetime that takes the database's close before
 * the services over it are created, so a failure to create them still
 * closes it.
 * @returns The database and its services.
 * @throws If the database cannot be opened, or as
 * {@link createDatabaseServices} throws.
 */
function acquireDatabaseServices(
  config: BackendConfig,
  factories: SingletonServiceFactories,
  serviceLifetime: AsyncDisposableStack
): AcquiredDatabase {
  const acquisition = factories.createDatabase(config.databaseFilePath)
  serviceLifetime.defer(acquisition.closeService)
  return Object.freeze({
    database: acquisition.service,
    services: createDatabaseServices(acquisition.service)
  })
}

/**
 * Creates the conversation services over the shared database, with the Sqlite
 * records they wrap.
 *
 * @param database - Shared database lent to every record; the caller keeps
 * ownership and closes it.
 * @returns The services, which own nothing to release.
 * @throws If the database is closed, the startup recovery of streaming replies
 * fails, or SQLite rejects the conversation search registration; services
 * created before the failure own nothing to release.
 * @remarks Turn persistence is created first, so its startup recovery runs
 * before any history is read.
 */
function createDatabaseServices(database: SqliteDatabase): DatabaseServices {
  const conversationTurns = StoredConversationTurns.create(
    new SqliteConversationTurnRecordWriter(database)
  )
  return {
    conversationTurns,
    replyParts: new StoredReplyParts(new SqliteReplyPartRecordWriter(database)),
    conversationHistoryReader: new StoredConversationHistoryReader(
      SqliteConversationRecordReader.create(database)
    ),
    conversationHistoryEditor: new StoredConversationHistoryEditor(
      new SqliteConversationRecordEditor(database)
    )
  }
}

/**
 * Creates the production chat adapter for the connected providers.
 *
 * @param options - Lookup of each connected provider's OpenAI-compatible
 * endpoint and the title-generation settings.
 * @returns The newly owned chat service and its cleanup capability.
 */
function createChatService(
  options: ChatServiceCreationOptions
): SingletonServiceAcquisition<ChatService> {
  const chatService = new ChatService(options)
  return Object.freeze({
    service: chatService,
    closeService: async () => await chatService[Symbol.asyncDispose]()
  })
}

/**
 * Opens the production backend database at one location.
 *
 * @param databaseFilePath - Absolute SQLite file location.
 * @returns The newly owned database and its cleanup capability.
 * @throws If the database cannot be opened, configured, or migrated; nothing
 * is left open.
 */
function createDatabase(
  databaseFilePath: BackendConfig["databaseFilePath"]
): SingletonServiceAcquisition<SqliteDatabase> {
  const database = SqliteDatabase.open(databaseFilePath)
  return Object.freeze({
    service: database,
    closeService: () =>
      new Promise<void>((resolve) => {
        database[Symbol.dispose]()
        resolve()
      })
  })
}

/**
 * Creates the production LLM runtime service of one provider.
 *
 * @param options - The provider; the settings file read, at every
 * connection attempt, for whether it is on, its address, and its key; the
 * reporters of its failures that no caller observes, including a missing
 * key or an unreadable settings file; and the logger of each acquired LM
 * Studio SDK client.
 * @returns The newly owned runtime service and its cleanup capability. No
 * file is read and no connection is attempted until the service is asked to
 * connect.
 */
function createLlmRuntimeService({
  provider,
  settingsFilePath,
  llmRuntimeFailureReporters,
  lmStudioSdkLogger
}: LlmRuntimeServiceFactoryOptions): SingletonServiceAcquisition<LlmRuntimeService> {
  const llmRuntimeService = new LlmRuntimeService({
    ...llmRuntimeFailureReporters,
    findLlmProviderAccess: async () =>
      await findLlmProviderAccess(settingsFilePath, provider),
    acquireLlmRuntime: async (access) =>
      await acquireLlmProviderRuntime(access, lmStudioSdkLogger)
  })
  return Object.freeze({
    service: llmRuntimeService,
    closeService: async () => await llmRuntimeService[Symbol.asyncDispose]()
  })
}

/**
 * Closes every application-scoped singleton service in reverse acquisition order.
 *
 * @param services - Service bundle owned by the closing application.
 * @returns A promise that resolves after all services have been disposed.
 * @throws If one or more services cannot complete disposal; every required
 * release is attempted and all failures are preserved by the disposal protocol.
 * @remarks Repeated and concurrent calls join the first cleanup operation.
 */
export async function closeSingletonServices(
  services: SingletonServices
): Promise<void> {
  await services[CLOSE_SINGLETON_SERVICES]()
}

/**
 * Builds the close operation of one singleton-service bundle.
 *
 * @param serviceLifetime - Owner of every service the bundle acquired.
 * @returns An operation that joins every close request to one complete
 * disposal of the owner; each call returns the same settlement.
 */
function buildCloseSingletonServices(
  serviceLifetime: AsyncDisposableStack
): CloseSingletonServices {
  let closeCompletion: Promise<void> | undefined = undefined
  return () => {
    closeCompletion ??= serviceLifetime.disposeAsync()
    return closeCompletion
  }
}

/**
 * Rejects a failed resource factory after closing every prior acquisition.
 *
 * @param creationFailure - Original failure that interrupted construction.
 * @param acquiredResources - Current owner of the acquisitions this call must release.
 * @param failureMessage - Context for the aggregate when construction and cleanup both fail.
 * @returns A promise that always rejects after cleanup settles.
 * @throws The original failure, or an aggregate retaining the construction
 * failure followed by the cleanup failure.
 */
async function throwCreationFailureAfterClosingResources(
  creationFailure: unknown,
  acquiredResources: AsyncDisposable,
  failureMessage: string
): Promise<never> {
  try {
    await acquiredResources[Symbol.asyncDispose]()
  } catch (cleanupError) {
    throw new AggregateError([creationFailure, cleanupError], failureMessage, {
      cause: cleanupError
    })
  }

  throw creationFailure
}
