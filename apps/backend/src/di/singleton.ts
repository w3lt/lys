import type { LoggerInterface } from "@lmstudio/sdk"
import { homedir } from "node:os"
import type { LlmProvider } from "@lys/share"
import type { BackendConfig } from "../config"
import SqliteAgentRecordStore from "../infrastructure/database/agents/sqliteAgentRecordStore"
import AttachmentFileStore from "../modules/attachment/attachmentFileStore"
import SqliteDatabase from "../infrastructure/database/sqliteDatabase"
import { acquireLlmProviderRuntime } from "../modules/llm/runtimes/llmProviderRuntime"
import AgentRuntimeService, {
  buildConversationTitleLookup
} from "../modules/agent/agentRuntimeService"
import AgentService from "../modules/agent/agentService"
import { buildBuiltInAgents } from "../modules/agent/builtInAgents"
import ChatService, {
  type ChatServiceCreationOptions
} from "../modules/chat/chatService"
import LlmReplyContextMeter from "../modules/chat/llmReplyContextMeter"
import OpenAiReplyModel from "../modules/chat/openAiReplyModel"
import SqliteConversationRecordEditor from "../infrastructure/database/conversations/sqliteConversationRecordEditor"
import SqliteConversationRecordReader from "../infrastructure/database/conversations/sqliteConversationRecordReader"
import SqliteConversationTurnRecordWriter from "../infrastructure/database/conversations/sqliteConversationTurnRecordWriter"
import SqliteReplyPartRecordWriter from "../infrastructure/database/conversations/sqliteReplyPartRecordWriter"
import SqliteToolSearchCallRecordWriter from "../infrastructure/database/conversations/sqliteToolSearchCallRecordWriter"
import StoredConversationHistoryEditor from "../modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../modules/conversation/historyReader"
import StoredReplyParts from "../modules/conversation/replyParts"
import StoredConversationTurns from "../modules/conversation/turns"
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
import { readJustRunToolNames } from "../infrastructure/settings/justRunToolsFile"
import { readEmailAccount } from "../infrastructure/settings/emailAccountFile"
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
  createEmailMcpServer
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
 * full: their failures and the LM Studio SDK's own messages.
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
   * Every tool the backend runs, in the order Settings lists them; they own
   * nothing to release.
   */
  builtInTools: readonly BuiltInToolEntry[]
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
   * tools; the bundle's cleanup closes it after the email account checker,
   * before the other services.
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
  /** Module-private cleanup capability for the complete owned service lifetime. */
  [CLOSE_SINGLETON_SERVICES]: CloseSingletonServices
}>

/**
 * Services that run, find, and approve tools; only the MCP server registry
 * and the email account checker own resources.
 */
type ToolServices = Pick<
  SingletonServices,
  | "builtInTools"
  | "webSearchToolProvider"
  | "toolApprovalService"
  | "mcpServerRegistry"
  | "mcpServerProcessGroups"
  | "emailAccountChecker"
>

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
 * file given to the holder of the MCP servers' process groups, and the
 * email server's path given to the built-in email server and the email
 * account checker.
 * @param logReporters - Receive, for logging, each provider's LLM runtime
 * failures that no caller observes, the causes of read failures the model
 * learns only by
 * kind, the LM Studio SDK's messages, the MCP servers' events, the
 * failures to save their process groups file, and the email account
 * checks.
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
 * The web search tool provider, the built-in tools, the tool approval
 * service, the MCP server registry, the email account checker, and the
 * attachment file store are created last; they read and contact nothing at
 * creation. Only the MCP server registry and the email account checker own
 * resources, the connections and the check process they open later; the
 * bundle's cleanup closes them first, the checker before the registry.
 * Creation stops at the first failure. The database is not part of the
 * returned bundle: the bundle's cleanup closes it last, after the chat
 * service and the LLM runtime services; it attempts every close even when
 * one fails, and keeps every failure.
 */
export async function createSingletonServices(
  config: BackendConfig,
  logReporters: SingletonLogReporters,
  factories: SingletonServiceFactories = DEFAULT_SINGLETON_SERVICE_FACTORIES
): Promise<SingletonServices> {
  const serviceLifetime = new AsyncDisposableStack()

  try {
    const databaseAcquisition = factories.createDatabase(
      config.databaseFilePath
    )
    serviceLifetime.defer(databaseAcquisition.closeService)
    const databaseServices = createDatabaseServices(databaseAcquisition.service)

    const llmProviderServices = buildLlmProviderRecord((provider) => {
      const acquisition = factories.createLlmRuntimeService(
        buildLlmRuntimeServiceFactoryOptions(provider, config, logReporters)
      )
      serviceLifetime.defer(acquisition.closeService)
      return createLlmProviderServices(acquisition.service)
    })

    const chatServiceAcquisition = factories.createChatService(
      buildChatServiceOptions(config, llmProviderServices)
    )
    serviceLifetime.defer(chatServiceAcquisition.closeService)
    const chatService = chatServiceAcquisition.service

    const agentServices = createAgentServices(
      config,
      databaseAcquisition.service,
      {
        chatService,
        llmProviderServices,
        historyReader: databaseServices.conversationHistoryReader
      }
    )
    const toolServices = createToolServices(config, logReporters)
    serviceLifetime.defer(buildCloseToolServices(toolServices))

    return Object.freeze({
      chatService,
      llmProviderServices,
      ...databaseServices,
      ...agentServices,
      ...toolServices,
      attachmentFileStore: new AttachmentFileStore(
        config.attachmentsDirectoryPath
      ),
      [CLOSE_SINGLETON_SERVICES]: buildCloseSingletonServices(serviceLifetime)
    })
  } catch (creationError) {
    return await throwCreationFailureAfterClosingResources(
      creationError,
      serviceLifetime,
      "Singleton service creation and cleanup both failed."
    )
  }
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
 * providers' LLM services they measure through, and the history reader that
 * titles their conversations.
 * @returns Both services, which read nothing at creation and own nothing to
 * release.
 */
function createAgentServices(
  config: BackendConfig,
  database: SqliteDatabase,
  { chatService, llmProviderServices, historyReader }: AgentRuntimeDependencies
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
      toolSearchCallRecords: new SqliteToolSearchCallRecordWriter(database)
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
 * @returns The web search tool provider, every built-in tool, the tool
 * approval service, the MCP server registry, whose stdio servers start in
 * the person's home folder and whose only built-in server is the email
 * server, the holder of those servers' process groups, which the registry
 * borrows, and the email account checker, which runs the same email
 * server; they read and contact nothing at creation.
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
): ToolServices {
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
  const mcpWorkingDirectory = homedir()
  const mcpServerRegistry = new McpServerRegistry({
    readSettings: () => readMcpSettings(config.settingsFilePath),
    builtInServers: [
      createEmailMcpServer(emailServerCommand, () =>
        readEmailAccount(config.settingsFilePath)
      )
    ],
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
    builtInTools,
    webSearchToolProvider,
    toolApprovalService,
    mcpServerRegistry,
    mcpServerProcessGroups,
    emailAccountChecker
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
