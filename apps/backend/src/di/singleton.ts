import type { BackendConfig } from "../config"
import SqliteDatabase, {
  type SqliteTransactions
} from "../infrastructure/database/sqliteDatabase"
import LmStudioRuntime from "../modules/llm/runtimes/lmStudioRuntime"
import ChatService, {
  type ChatServiceCreationOptions
} from "./services/chatService"
import ConversationService from "./services/conversationService"
import LlmRuntimeService, {
  type LlmRuntimeFailureReporters
} from "./services/llmRuntimeService"
import LlmService from "./services/llmService"

/** Private close operation owned by one returned singleton-service bundle. */
const CLOSE_SINGLETON_SERVICES = Symbol("close-singleton-services")

/** Closes all resources owned by one singleton-service bundle. */
type CloseSingletonServices = () => Promise<void>

/**
 * One newly acquired service or shared resource paired with its exclusive
 * cleanup capability.
 */
export type SingletonServiceAcquisition<Service> = Readonly<{
  /** Acquired value lent to the singleton bundle or to the services built on it. */
  service: Service
  /** Releases every resource exclusively owned by the acquired value. */
  closeService: () => Promise<void>
}>

/** Factories for the application services and the shared database they use. */
export type SingletonServiceFactories = Readonly<{
  /** Creates the chat service for one OpenAI-compatible HTTP endpoint and its title settings. */
  createChatService: (
    options: ChatServiceCreationOptions
  ) => SingletonServiceAcquisition<ChatService>
  /**
   * Opens and migrates the shared SQLite database at one location, lending only
   * its transactions.
   */
  openDatabase: (
    databaseFilePath: BackendConfig["databaseFilePath"]
  ) => SingletonServiceAcquisition<SqliteTransactions>
  /**
   * Creates the conversation store on the shared database; the store owns
   * nothing to release.
   */
  createConversationService: (
    database: SqliteTransactions
  ) => ConversationService
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
  openDatabase,
  createConversationService,
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
  /** Conversation persistence on the shared SQLite database. */
  conversationService: ConversationService
  /** Module-private cleanup capability for the complete owned service lifetime. */
  [CLOSE_SINGLETON_SERVICES]: CloseSingletonServices
}>

/**
 * Creates the application-scoped service bundle from backend network configuration.
 *
 * @param config - LM Studio host and port used to derive local service endpoints,
 * the SQLite database location, and the title-generation prompt and title
 * length limit given to the chat service.
 * @param llmRuntimeFailureReporters - Receive the LLM runtime failures that no
 * caller observes, for logging.
 * @param factories - Service factories owned by the composition root.
 * @returns A promise resolving to the owned service bundle configured with the
 * HTTP `/v1` chat endpoint and WebSocket LM Studio endpoint. The bundle also
 * owns the shared database, which only the services built on it can use. No
 * service contacts LM Studio during creation; the runtime service connects
 * later.
 * @throws If service or database creation fails; every resource acquired before
 * the failure is closed before the rejection settles.
 */
export async function createSingletonServices(
  config: BackendConfig,
  llmRuntimeFailureReporters: LlmRuntimeFailureReporters,
  factories: SingletonServiceFactories = DEFAULT_SINGLETON_SERVICE_FACTORIES
): Promise<SingletonServices> {
  const serviceLifetime = new AsyncDisposableStack()

  try {
    const chatServiceOptions: ChatServiceCreationOptions = {
      openAiBaseUrl: `http://${config.lmstudioHost}:${config.lmstudioPort}/v1`,
      titleGenerationPrompt: config.titleGenerationPrompt,
      generatedTitleMaxLength: config.generatedTitleMaxLength
    }
    const chatServiceAcquisition =
      factories.createChatService(chatServiceOptions)
    serviceLifetime.defer(chatServiceAcquisition.closeService)

    const databaseAcquisition = factories.openDatabase(config.databaseFilePath)
    serviceLifetime.defer(databaseAcquisition.closeService)
    const conversationService = factories.createConversationService(
      databaseAcquisition.service
    )

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
      chatService: chatServiceAcquisition.service,
      llmService,
      llmRuntimeService: llmRuntimeServiceAcquisition.service,
      conversationService,
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
 * Opens the production shared SQLite database for one location.
 *
 * @param databaseFilePath - SQLite location owned by the returned acquisition.
 * @returns Transactional access for stores and the capability that closes the
 * database.
 * @throws If the database cannot be opened or migrated; nothing remains open.
 */
function openDatabase(
  databaseFilePath: BackendConfig["databaseFilePath"]
): SingletonServiceAcquisition<SqliteTransactions> {
  const database = SqliteDatabase.open(databaseFilePath)
  return Object.freeze({
    service: database,
    closeService: async () => {
      database[Symbol.dispose]()
    }
  })
}

/**
 * Creates the production conversation store on the shared database.
 *
 * @param database - Migrated shared database borrowed for the store's lifetime.
 * @returns The ready conversation service; it owns nothing to release.
 * @throws If the database is closed or conversation setup fails.
 */
function createConversationService(
  database: SqliteTransactions
): ConversationService {
  return ConversationService.create(database)
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
 * @throws The original failure, or an aggregate retaining both construction and cleanup failures.
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
