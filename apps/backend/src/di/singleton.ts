import type { BackendConfig } from "../config"
import LmStudioRuntime from "../modules/llm/runtimes/lmStudioRuntime"
import ChatService from "./services/chatService"
import ConversationService from "./services/conversationService"
import LlmService from "./services/llmService"

/** Private close operation owned by one returned singleton-service bundle. */
const CLOSE_SINGLETON_SERVICES = Symbol("close-singleton-services")

/** Closes all resources owned by one singleton-service bundle. */
type CloseSingletonServices = () => Promise<void>

/** One newly acquired service paired with its exclusive cleanup capability. */
export type SingletonServiceAcquisition<Service> = Readonly<{
  /** Service value transferred to the singleton bundle. */
  service: Service
  /** Releases every resource exclusively owned by the service. */
  closeService: () => Promise<void>
}>

/** Factories for the three independently acquired application services. */
export type SingletonServiceFactories = Readonly<{
  /** Creates the chat service for one OpenAI-compatible HTTP endpoint. */
  createChatService: (
    openAiBaseUrl: string
  ) => SingletonServiceAcquisition<ChatService>
  /** Creates the conversation store for one database location. */
  createConversationService: (
    databaseFilePath: BackendConfig["databaseFilePath"]
  ) => SingletonServiceAcquisition<ConversationService>
  /** Creates the owned LLM service for one LM Studio WebSocket endpoint. */
  createLlmService: (
    lmsBaseUrl: string
  ) => Promise<SingletonServiceAcquisition<LlmService>>
}>

/** Production factories used when the composition root supplies no substitutes. */
const DEFAULT_SINGLETON_SERVICE_FACTORIES = Object.freeze({
  createChatService,
  createConversationService,
  createLlmService
} satisfies SingletonServiceFactories)

/** Application-scoped services owned for a Fastify application's lifetime. */
export type SingletonServices = Readonly<{
  /** Chat completion adapter configured for the backend's local endpoint. */
  chatService: ChatService
  /** LLM inventory and lifecycle service owned by the application. */
  llmService: LlmService
  /** SQLite-backed conversation persistence owned by the application lifetime. */
  conversationService: ConversationService
  /** Module-private cleanup capability for the complete owned service lifetime. */
  [CLOSE_SINGLETON_SERVICES]: CloseSingletonServices
}>

/**
 * Creates the application-scoped service bundle from backend network configuration.
 *
 * @param config - LM Studio host and port used to derive local service endpoints.
 * @param factories - Service factories owned by the composition root.
 * @returns A promise resolving to the owned service bundle configured with the
 * HTTP `/v1` chat endpoint and WebSocket LM Studio endpoint.
 * @throws If service construction fails; every resource acquired before the
 * failure is closed before the rejection settles.
 */
export async function createSingletonServices(
  config: BackendConfig,
  factories: SingletonServiceFactories = DEFAULT_SINGLETON_SERVICE_FACTORIES
): Promise<SingletonServices> {
  const serviceLifetime = new AsyncDisposableStack()

  try {
    const chatServiceAcquisition = factories.createChatService(
      `http://${config.lmstudioHost}:${config.lmstudioPort}/v1`
    )
    serviceLifetime.defer(chatServiceAcquisition.closeService)

    const conversationServiceAcquisition = factories.createConversationService(
      config.databaseFilePath
    )
    serviceLifetime.defer(conversationServiceAcquisition.closeService)

    const llmServiceAcquisition = await factories.createLlmService(
      `ws://${config.lmstudioHost}:${config.lmstudioPort}`
    )
    serviceLifetime.defer(llmServiceAcquisition.closeService)
    let closeCompletion: Promise<void> | undefined = undefined

    /** Joins every close request to one complete service-lifetime disposal. */
    const closeOwnedSingletonServices = (): Promise<void> => {
      closeCompletion ??= serviceLifetime.disposeAsync()
      return closeCompletion
    }

    return Object.freeze({
      chatService: chatServiceAcquisition.service,
      llmService: llmServiceAcquisition.service,
      conversationService: conversationServiceAcquisition.service,
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
 * @param openAiBaseUrl - OpenAI-compatible base URL used by the chat SDK.
 * @returns The newly owned chat service and its cleanup capability.
 */
function createChatService(
  openAiBaseUrl: string
): SingletonServiceAcquisition<ChatService> {
  const chatService = new ChatService({ openAiBaseUrl })
  return Object.freeze({
    service: chatService,
    closeService: async () => await chatService[Symbol.asyncDispose]()
  })
}

/**
 * Creates the production conversation store for one database location.
 *
 * @param databaseFilePath - SQLite database location owned by the service.
 * @returns The newly owned conversation service and its cleanup capability.
 * @throws If the database cannot be opened, migrated, or prepared.
 */
function createConversationService(
  databaseFilePath: BackendConfig["databaseFilePath"]
): SingletonServiceAcquisition<ConversationService> {
  const conversationService = ConversationService.open(databaseFilePath)
  return Object.freeze({
    service: conversationService,
    closeService: async () => {
      conversationService[Symbol.dispose]()
    }
  })
}

/**
 * Creates the production LLM service for one WebSocket endpoint.
 *
 * @param lmsBaseUrl - WebSocket endpoint used by the SDK client.
 * @returns A promise resolving to the newly owned service and its cleanup capability.
 * @throws If runtime or service creation fails. Cleanup follows the current
 * owner, preserving both creation and release failures when both occur.
 */
async function createLlmService(
  lmsBaseUrl: string
): Promise<SingletonServiceAcquisition<LlmService>> {
  const runtime = await LmStudioRuntime.create(lmsBaseUrl)
  let cleanupOwner: AsyncDisposable = runtime

  try {
    const service = new LlmService({ runtime })
    cleanupOwner = service
    return Object.freeze({
      service,
      closeService: async () => await service[Symbol.asyncDispose]()
    })
  } catch (creationFailure) {
    return await throwCreationFailureAfterClosingResources(
      creationFailure,
      cleanupOwner,
      "LLM service creation and cleanup both failed."
    )
  }
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
