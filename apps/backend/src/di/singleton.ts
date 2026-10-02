import type { BackendConfig } from "../config"
import SqliteDatabase from "../infrastructure/database/sqliteDatabase"
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
   * Creates the conversation service over the shared database. The service
   * borrows the database and owns nothing to release.
   */
  createConversationService: (database: SqliteDatabase) => ConversationService
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
  /** SQLite-backed conversation persistence owned by the application lifetime. */
  conversationService: ConversationService
  /** Module-private cleanup capability for the complete owned service lifetime. */
  [CLOSE_SINGLETON_SERVICES]: CloseSingletonServices
}>

/**
 * Creates the application-scoped service bundle from backend network configuration.
 *
 * @param config - LM Studio host and port used to derive local service endpoints,
 * and the title-generation prompt and title length limit given to the chat
 * service.
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
 * runtime service, and the conversation service is created over the database
 * before the runtime service; creation stops at the first failure. The
 * database is not part of the returned bundle: the bundle's cleanup closes it
 * after the LLM runtime service and before the chat service.
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

    const databaseAcquisition = factories.createDatabase(
      config.databaseFilePath
    )
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
 * Creates the production conversation service over the shared database.
 *
 * @param database - Open database owned by the singleton bundle; the service
 * borrows only its read, write, and function-registration capabilities.
 * @returns The ready conversation service, which owns nothing to release.
 * @throws If the database is closed, or registering conversation search or
 * recovering interrupted replies fails.
 */
function createConversationService(
  database: SqliteDatabase
): ConversationService {
  return ConversationService.create({
    databaseReader: database,
    databaseWriter: database,
    databaseFunctionRegistry: database
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
