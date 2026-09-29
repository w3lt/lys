import { describe, expect, it, onTestFinished, vi } from "vitest"
import ChatService from "../../../src/di/services/chatService"
import SqliteConversationStore from "../../../src/di/services/conversationService"
import LlmRuntimeService, {
  type LlmRuntimeFailureReporters
} from "../../../src/di/services/llmRuntimeService"
import LlmService from "../../../src/di/services/llmService"
import {
  closeSingletonServices,
  createSingletonServices,
  type SingletonServiceAcquisition,
  type SingletonServiceFactories,
  type SingletonServices
} from "../../../src/di/singleton"
import { TEST_BACKEND_CONFIG } from "../support/backendConfig"

/** Name of each independently acquired service. */
type ServiceName = "chat" | "conversation" | "llm-runtime"

/**
 * Creates failure reporters that record what they receive.
 *
 * @returns Reporters whose calls each case can inspect.
 */
function createFailureReporters() {
  return {
    reportLlmRuntimeAcquisitionFailure: vi.fn(),
    reportLlmRuntimeAvailabilityCheckFailure: vi.fn()
  } satisfies LlmRuntimeFailureReporters
}

/**
 * Pairs a service with a recorded cleanup capability.
 *
 * @param service - Acquired service.
 * @param name - Name recorded when the cleanup runs.
 * @param closeLog - Shared log of cleanup calls in call order.
 * @returns The acquisition handed to the composition root.
 */
function createAcquisition<Service>(
  service: Service,
  name: ServiceName,
  closeLog: ServiceName[]
) {
  return {
    service,
    closeService: vi.fn(async () => {
      closeLog.push(name)
    })
  } satisfies SingletonServiceAcquisition<Service>
}

/**
 * Creates factories returning real services with recorded cleanup.
 *
 * @returns The factory mocks, their acquisitions, and the cleanup log.
 * @remarks The conversation store is in memory, and the LLM runtime service
 * is never connected: its runtime acquisition rejects if anything attempts it.
 * No external resource is acquired.
 */
function createRecordedFactories() {
  const closeLog: ServiceName[] = []
  const store = SqliteConversationStore.open(":memory:")
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  const acquisitions = {
    chat: createAcquisition(
      new ChatService({
        openAiBaseUrl: "http://lmstudio.test/v1",
        titleGenerationPrompt: "prompt",
        generatedTitleMaxLength: 10
      }),
      "chat",
      closeLog
    ),
    conversation: createAcquisition(store, "conversation", closeLog),
    llmRuntime: createAcquisition(
      new LlmRuntimeService({
        ...createFailureReporters(),
        acquireLlmRuntime: async () => {
          throw new Error("Unexpected LLM runtime acquisition")
        }
      }),
      "llm-runtime",
      closeLog
    )
  }
  const factories = {
    createChatService: vi.fn<SingletonServiceFactories["createChatService"]>(
      () => acquisitions.chat
    ),
    createConversationService: vi.fn<
      SingletonServiceFactories["createConversationService"]
    >(() => acquisitions.conversation),
    createLlmRuntimeService: vi.fn<
      SingletonServiceFactories["createLlmRuntimeService"]
    >(() => acquisitions.llmRuntime)
  }
  return { factories, acquisitions, closeLog }
}

describe("createSingletonServices", () => {
  it("derives each service's endpoint and settings from the configuration", async () => {
    const { factories } = createRecordedFactories()
    const reporters = createFailureReporters()

    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      reporters,
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(factories.createChatService).toHaveBeenCalledWith({
      openAiBaseUrl: "http://lmstudio.test:4321/v1",
      titleGenerationPrompt: TEST_BACKEND_CONFIG.titleGenerationPrompt,
      generatedTitleMaxLength: TEST_BACKEND_CONFIG.generatedTitleMaxLength
    })
    expect(factories.createConversationService).toHaveBeenCalledWith(
      TEST_BACKEND_CONFIG.databaseFilePath
    )
    expect(factories.createLlmRuntimeService).toHaveBeenCalledWith(
      "ws://lmstudio.test:4321",
      reporters
    )
  })

  it("returns a frozen bundle of the acquired services", async () => {
    const { factories, acquisitions } = createRecordedFactories()

    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createFailureReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(Object.isFrozen(services)).toBe(true)
    expect(services.chatService).toBe(acquisitions.chat.service)
    expect(services.conversationService).toBe(acquisitions.conversation.service)
    expect(services.llmRuntimeService).toBe(acquisitions.llmRuntime.service)
    expect(services.llmService).toBeInstanceOf(LlmService)
  })

  it("releases the chat service when the conversation store cannot be created", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const creationFailure = new Error("unable to open database file")
    factories.createConversationService.mockImplementation(() => {
      throw creationFailure
    })

    await expect(
      createSingletonServices(
        TEST_BACKEND_CONFIG,
        createFailureReporters(),
        factories
      )
    ).rejects.toBe(creationFailure)

    expect(closeLog).toEqual(["chat"])
    expect(factories.createLlmRuntimeService).not.toHaveBeenCalled()
  })

  it("releases earlier services in reverse order when the LLM runtime service cannot be created", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const creationFailure = new Error("LLM runtime service construction failed")
    factories.createLlmRuntimeService.mockImplementation(() => {
      throw creationFailure
    })

    await expect(
      createSingletonServices(
        TEST_BACKEND_CONFIG,
        createFailureReporters(),
        factories
      )
    ).rejects.toBe(creationFailure)

    expect(closeLog).toEqual(["conversation", "chat"])
  })

  it("keeps both failures when releasing earlier services also fails", async () => {
    const { factories, acquisitions, closeLog } = createRecordedFactories()
    const creationFailure = new Error("LLM runtime service construction failed")
    const cleanupFailure = new Error("database is locked")
    factories.createLlmRuntimeService.mockImplementation(() => {
      throw creationFailure
    })
    acquisitions.conversation.closeService.mockRejectedValue(cleanupFailure)

    const failure = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createFailureReporters(),
      factories
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({
      message: "Singleton service creation and cleanup both failed.",
      errors: [creationFailure, cleanupFailure],
      cause: cleanupFailure
    })
    expect(closeLog).toEqual(["chat"])
  })
})

describe("closeSingletonServices", () => {
  /**
   * Creates a bundle from recorded factories.
   *
   * @returns The bundle and the recorded acquisitions and cleanup log.
   */
  async function createRecordedServices() {
    const recorded = createRecordedFactories()
    const services: SingletonServices = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createFailureReporters(),
      recorded.factories
    )
    return { services, ...recorded }
  }

  it("releases every service in reverse acquisition order", async () => {
    const { services, closeLog } = await createRecordedServices()

    await closeSingletonServices(services)

    expect(closeLog).toEqual(["llm-runtime", "conversation", "chat"])
  })

  it("joins repeated and concurrent calls to one release of each service", async () => {
    const { services, acquisitions } = await createRecordedServices()

    await Promise.all([
      closeSingletonServices(services),
      closeSingletonServices(services)
    ])
    await closeSingletonServices(services)

    for (const acquisition of Object.values(acquisitions)) {
      expect(acquisition.closeService).toHaveBeenCalledOnce()
    }
  })

  it("attempts every release and rejects with the failure", async () => {
    const { services, acquisitions, closeLog } = await createRecordedServices()
    const releaseFailure = new Error("runtime release failed")
    acquisitions.llmRuntime.closeService.mockRejectedValue(releaseFailure)

    await expect(closeSingletonServices(services)).rejects.toBe(releaseFailure)

    expect(closeLog).toEqual(["conversation", "chat"])
    await expect(closeSingletonServices(services)).rejects.toBe(releaseFailure)
    expect(acquisitions.llmRuntime.closeService).toHaveBeenCalledOnce()
  })
})
