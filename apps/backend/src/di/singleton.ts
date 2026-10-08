import type { BackendConfig } from "../config"
import SqliteAgentRecordStore from "../infrastructure/database/agents/sqliteAgentRecordStore"
import SqliteDatabase from "../infrastructure/database/sqliteDatabase"
import LmStudioRuntime from "../modules/llm/runtimes/lmStudioRuntime"
import AgentService from "../modules/agent/agentService"
import ChatService, {
  type ChatServiceCreationOptions
} from "../modules/chat/chatService"
import OpenAiReplyModel from "../modules/chat/openAiReplyModel"
import SqliteConversationRecordEditor from "../infrastructure/database/conversations/sqliteConversationRecordEditor"
import SqliteConversationRecordReader from "../infrastructure/database/conversations/sqliteConversationRecordReader"
import SqliteConversationTurnRecordWriter from "../infrastructure/database/conversations/sqliteConversationTurnRecordWriter"
import StoredConversationHistoryEditor from "../modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../modules/conversation/historyReader"
import StoredConversationTurns from "../modules/conversation/turns"
import LlmRuntimeService, {
  type LlmRuntimeFailureReporters
} from "../modules/llm/llmRuntimeService"
import LlmService from "../modules/llm/llmService"

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

/** Factories for the independently created application services and the database they share. */
export type SingletonServiceFactories = Readonly<{
  /** Creates the chat service for one OpenAI-compatible HTTP endpoint and its title settings. */
  createChatService: (
    options: ChatServiceCreationOptions
  ) => SingletonServiceAcquisition<ChatService>
  /** Opens the shared backend database at one location. */
  createDatabase: (
    databaseFilePath: BackendConfig["databaseFilePath"]
  ) => SingletonServiceAcquisition<SqliteDatabase>
  /**
   * Creates the owned LLM runtime service for one LM Studio WebSocket endpoint
   * without contacting it.
   */
  createLlmRuntimeService: (
    lmsBaseUrl: string,
    llmRuntimeFailureReporters: LlmRuntimeFailureReporters
  ) => SingletonServiceAcquisition<LlmRuntimeService>
}>

/** Production factories used when the composition root supplies no substitutes. */
const DEFAULT_SINGLETON_SERVICE_FACTORIES = Object.freeze({
  createChatService,
  createDatabase,
  createLlmRuntimeService
} satisfies SingletonServiceFactories)

/** Application-scoped services owned for a Fastify application's lifetime. */
export type SingletonServices = Readonly<{
  /** Chat completion adapter configured for the backend's local endpoint. */
  chatService: ChatService
  /** LLM model policy served through the runtime service's queue. */
  llmService: LlmService
  /** LLM runtime connection and model-operation queue owned by the application. */
  llmRuntimeService: LlmRuntimeService
  /** Turn persistence over the shared database; it owns nothing to release. */
  conversationTurns: StoredConversationTurns
  /** History reading over the shared database; it owns nothing to release. */
  conversationHistoryReader: StoredConversationHistoryReader
  /** History editing over the shared database; it owns nothing to release. */
  conversationHistoryEditor: StoredConversationHistoryEditor
  /**
   * Agent definitions over agent records on the shared database, and Lys over
   * the chat service; it owns nothing to release.
   */
  agentService: AgentService
  /** Module-private cleanup capability for the complete owned service lifetime. */
  [CLOSE_SINGLETON_SERVICES]: CloseSingletonServices
}>

/** Services that keep their data in the shared database and own nothing. */
type DatabaseServices = Pick<
  SingletonServices,
  | "conversationTurns"
  | "conversationHistoryReader"
  | "conversationHistoryEditor"
>

/**
 * Creates the application-scoped service bundle from backend network configuration.
 *
 * @param config - LM Studio host and port used to derive local service endpoints,
 * the title-generation prompt and title length limit given to the chat
 * service, and the Lys system prompt given to the agent service.
 * @param llmRuntimeFailureReporters - Receive the LLM runtime failures that no
 * caller observes, for logging.
 * @param factories - Service factories owned by the composition root.
 * @returns A promise resolving to the frozen bundle of owned services,
 * configured with the HTTP `/v1` chat endpoint and WebSocket LM Studio
 * endpoint. No service contacts LM Studio during creation; the runtime service
 * connects later.
 * @throws The original construction failure, after every resource acquired
 * before it is closed.
 * @throws {AggregateError} If closing the acquired resources also fails; its
 * errors hold the construction failure followed by the cleanup failure.
 * @remarks Resources are acquired in the order chat service, database, LLM
 * runtime service. The conversation services and the Sqlite records they
 * wrap are created over the database before the runtime service, turn
 * persistence first, so its startup recovery runs before any history is
 * read. The agent service is created next, over its Sqlite records and the
 * chat service; it reads nothing at creation and owns nothing to release.
 * Creation stops at the first failure. The database is not part of the
 * returned bundle: the bundle's cleanup closes it after the LLM runtime
 * service and before the chat service.
 */
export async function createSingletonServices(
  config: BackendConfig,
  llmRuntimeFailureReporters: LlmRuntimeFailureReporters,
  factories: SingletonServiceFactories = DEFAULT_SINGLETON_SERVICE_FACTORIES
): Promise<SingletonServices> {
  const serviceLifetime = new AsyncDisposableStack()

  try {
    const chatServiceAcquisition = factories.createChatService({
      openAiBaseUrl: `http://${config.lmstudioHost}:${config.lmstudioPort}/v1`,
      titleGenerationPrompt: config.titleGenerationPrompt,
      generatedTitleMaxLength: config.generatedTitleMaxLength
    })
    serviceLifetime.defer(chatServiceAcquisition.closeService)
    const chatService = chatServiceAcquisition.service

    const databaseAcquisition = factories.createDatabase(
      config.databaseFilePath
    )
    serviceLifetime.defer(databaseAcquisition.closeService)
    const databaseServices = createDatabaseServices(databaseAcquisition.service)
    const agentService = new AgentService({
      recordStore: new SqliteAgentRecordStore(databaseAcquisition.service),
      lysSystemPrompt: config.lysSystemPrompt,
      replyModel: new OpenAiReplyModel((options) =>
        chatService.completeChatStream(options)
      )
    })

    const llmRuntimeServiceAcquisition = factories.createLlmRuntimeService(
      `ws://${config.lmstudioHost}:${config.lmstudioPort}`,
      llmRuntimeFailureReporters
    )
    serviceLifetime.defer(llmRuntimeServiceAcquisition.closeService)
    const llmService = new LlmService({
      llmEngineOperationQueue: llmRuntimeServiceAcquisition.service
    })
    let closeCompletion: Promise<void> | undefined = undefined

    /** Joins every close request to one complete service-lifetime disposal. */
    const closeOwnedSingletonServices = (): Promise<void> => {
      closeCompletion ??= serviceLifetime.disposeAsync()
      return closeCompletion
    }

    return Object.freeze({
      chatService,
      llmService,
      llmRuntimeService: llmRuntimeServiceAcquisition.service,
      ...databaseServices,
      agentService,
      [CLOSE_SINGLETON_SERVICES]: closeOwnedSingletonServices
    })
  } catch (creationFailure) {
    return await throwCreationFailureAfterClosingResources(
      creationFailure,
      serviceLifetime,
      "Singleton service creation and cleanup both failed."
    )
  }
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
    conversationHistoryReader: new StoredConversationHistoryReader(
      SqliteConversationRecordReader.create(database)
    ),
    conversationHistoryEditor: new StoredConversationHistoryEditor(
      new SqliteConversationRecordEditor(database)
    )
  }
}

/**
 * Creates the production chat adapter for one HTTP endpoint.
 *
 * @param options - OpenAI-compatible base URL used by the chat SDK and the
 * title-generation settings.
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
    closeService: async () => {
      database[Symbol.dispose]()
    }
  })
}

/**
 * Creates the production LLM runtime service for one WebSocket endpoint.
 *
 * @param lmsBaseUrl - WebSocket endpoint used by each acquired SDK client.
 * @param llmRuntimeFailureReporters - Receive failures that no caller observes.
 * @returns The newly owned runtime service and its cleanup capability. No
 * connection is attempted until the service is asked to connect.
 */
function createLlmRuntimeService(
  lmsBaseUrl: string,
  llmRuntimeFailureReporters: LlmRuntimeFailureReporters
): SingletonServiceAcquisition<LlmRuntimeService> {
  const llmRuntimeService = new LlmRuntimeService({
    ...llmRuntimeFailureReporters,
    acquireLlmRuntime: async () => await LmStudioRuntime.create(lmsBaseUrl)
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
  } catch (cleanupFailure) {
    throw new AggregateError(
      [creationFailure, cleanupFailure],
      failureMessage,
      { cause: cleanupFailure }
    )
  }

  throw creationFailure
}
