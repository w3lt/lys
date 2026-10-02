import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { backendConfigSchema } from "../../../src/config"
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
import SqliteDatabase from "../../../src/infrastructure/database/sqliteDatabase"
import { TEST_BACKEND_CONFIG } from "../support/backendConfig"

/** Name of each acquisition whose release the bundle owns. */
type AcquisitionName = "chat" | "database" | "llm-runtime"

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
 * Pairs an acquired value with a recorded cleanup capability.
 *
 * @param service - Acquired value.
 * @param name - Name recorded when the cleanup runs.
 * @param closeLog - Shared log of cleanup calls in call order.
 * @returns The acquisition handed to the composition root.
 */
function createAcquisition<Service>(
  service: Service,
  name: AcquisitionName,
  closeLog: AcquisitionName[]
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
 * @returns The factory mocks, their acquisitions, the conversation service,
 * and the cleanup log.
 * @remarks The database is in memory and closed when the test finishes, and the
 * LLM runtime service is never connected: its runtime acquisition rejects if
 * anything attempts it. No external resource is acquired.
 */
function createRecordedFactories() {
  const closeLog: AcquisitionName[] = []
  const database = SqliteDatabase.open(":memory:")
  onTestFinished(() => {
    database[Symbol.dispose]()
  })
  const conversationService = SqliteConversationStore.create({
    databaseReader: database,
    databaseWriter: database,
    databaseFunctionRegistry: database
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
    database: createAcquisition(database, "database", closeLog),
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
    createDatabase: vi.fn<SingletonServiceFactories["createDatabase"]>(
      () => acquisitions.database
    ),
    createConversationService: vi.fn<
      SingletonServiceFactories["createConversationService"]
    >(() => conversationService),
    createLlmRuntimeService: vi.fn<
      SingletonServiceFactories["createLlmRuntimeService"]
    >(() => acquisitions.llmRuntime)
  }
  return { factories, acquisitions, conversationService, closeLog }
}

describe("createSingletonServices", () => {
  it("derives each acquisition from the configuration and builds conversations over the database", async () => {
    const { factories, acquisitions } = createRecordedFactories()
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
    expect(factories.createDatabase).toHaveBeenCalledWith(
      TEST_BACKEND_CONFIG.databaseFilePath
    )
    expect(factories.createConversationService).toHaveBeenCalledWith(
      acquisitions.database.service
    )
    expect(factories.createLlmRuntimeService).toHaveBeenCalledWith(
      "ws://lmstudio.test:4321",
      reporters
    )
  })

  it("returns a frozen bundle of the services", async () => {
    const { factories, acquisitions, conversationService } =
      createRecordedFactories()

    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createFailureReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(Object.isFrozen(services)).toBe(true)
    expect(services.chatService).toBe(acquisitions.chat.service)
    expect(services.conversationService).toBe(conversationService)
    expect(services.llmRuntimeService).toBe(acquisitions.llmRuntime.service)
    expect(services.llmService).toBeInstanceOf(LlmService)
  })

  it("serves the LLM service through the runtime service's operation queue", async () => {
    const { factories, acquisitions } = createRecordedFactories()
    const refusal = new Error("The LLM runtime is closed.")
    const handleLlmEngineOperationRequest = vi
      .spyOn(acquisitions.llmRuntime.service, "handleLlmEngineOperationRequest")
      .mockRejectedValue(refusal)
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createFailureReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    await expect(services.llmService.listLlmModels()).rejects.toBe(refusal)

    expect(handleLlmEngineOperationRequest).toHaveBeenCalledOnce()
  })

  it("releases the chat service when the database cannot be opened", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const creationFailure = new Error("unable to open database file")
    factories.createDatabase.mockImplementation(() => {
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
    expect(factories.createConversationService).not.toHaveBeenCalled()
  })

  it("releases the database and the chat service when the conversation service cannot be created", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const creationFailure = new Error("recovery failed")
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

    expect(closeLog).toEqual(["database", "chat"])
    expect(factories.createLlmRuntimeService).not.toHaveBeenCalled()
  })

  it("releases earlier acquisitions in reverse order when the LLM runtime service cannot be created", async () => {
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

    expect(closeLog).toEqual(["database", "chat"])
  })

  it("keeps both failures when releasing earlier acquisitions also fails", async () => {
    const { factories, acquisitions, closeLog } = createRecordedFactories()
    const creationFailure = new Error("LLM runtime service construction failed")
    const cleanupFailure = new Error("database is locked")
    factories.createLlmRuntimeService.mockImplementation(() => {
      throw creationFailure
    })
    acquisitions.database.closeService.mockRejectedValue(cleanupFailure)

    const failure = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createFailureReporters(),
      factories
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({
      errors: [creationFailure, cleanupFailure]
    })
    expect(closeLog).toEqual(["chat"])
  })

  it("opens the configured database with the production factories and closes it with the bundle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lys-singleton-test-"))
    onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true })
    })
    const config = backendConfigSchema.parse({
      ...TEST_BACKEND_CONFIG,
      databaseFilePath: join(directory, "lys_db.sqlite")
    })
    const services = await createSingletonServices(
      config,
      createFailureReporters()
    )
    const history = services.conversationService.createHistoryAccess()
    const turn = services.conversationService
      .createTurnAccess()
      .createConversationTurn({
        userMessageContent: "Hello",
        model: "qwen/qwen3-8b",
        systemPrompt: "You are Lys."
      })
    expect(history.getConversation(turn.conversation.id)).toBeDefined()

    await closeSingletonServices(services)

    expect(() => history.getConversation(turn.conversation.id)).toThrow(
      "Database is closed"
    )
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

  it("releases every acquisition in reverse acquisition order", async () => {
    const { services, closeLog } = await createRecordedServices()

    await closeSingletonServices(services)

    expect(closeLog).toEqual(["llm-runtime", "database", "chat"])
  })

  it("joins repeated and concurrent calls to one release of each acquisition", async () => {
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

    expect(closeLog).toEqual(["database", "chat"])
    await expect(closeSingletonServices(services)).rejects.toBe(releaseFailure)
    expect(acquisitions.llmRuntime.closeService).toHaveBeenCalledOnce()
  })
})
