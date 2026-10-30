import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { groqApiKeySchema } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { backendConfigSchema } from "../../../src/config"
import type { AgentTurn } from "../../../src/modules/agent/agent"
import AgentRuntimeService from "../../../src/modules/agent/agentRuntimeService"
import AgentService from "../../../src/modules/agent/agentService"
import { NO_UNOFFERED_TOOLS } from "../../../src/modules/agent/unofferedTools"
import ChatService from "../../../src/modules/chat/chatService"
import StoredConversationHistoryEditor from "../../../src/modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../../../src/modules/conversation/historyReader"
import AttachmentFileStore from "../../../src/modules/attachment/attachmentFileStore"
import StoredReplyParts from "../../../src/modules/conversation/replyParts"
import StoredConversationTurns from "../../../src/modules/conversation/turns"
import LlmRuntimeService, {
  type LlmRuntimeFailureReporters
} from "../../../src/modules/llm/llmRuntimeService"
import LlmService from "../../../src/modules/llm/llmService"
import {
  closeSingletonServices,
  createSingletonServices,
  type SingletonLogReporters,
  type SingletonServiceAcquisition,
  type SingletonServiceFactories,
  type SingletonServices
} from "../../../src/di/singleton"
import SqliteDatabase from "../../../src/infrastructure/database/sqliteDatabase"
import { TEST_BACKEND_CONFIG } from "../support/backendConfig"
import {
  createFixtureUuidV7,
  createNewConversationTarget,
  createTurnUserMessage,
  createUserMessage
} from "../support/conversationFixtures"
import {
  createAcquiredFakeLlmRuntime,
  createConnectedFakeLlmEngine,
  createFakeLlmRuntime
} from "../support/fakeLlmRuntime"
import { writeSettingsFile } from "../support/settingsFile"
import { answerWithBody, startVmoServer } from "../support/vmoServer"

// The bundle imports the LM Studio SDK through its runtime adapter. No case
// connects the runtime, so no case arranges the fake engine.
vi.mock("@lmstudio/sdk", () => import("../support/lmStudioSdkFake"))

/** Name of each acquisition whose release the bundle owns. */
type AcquisitionName = "chat" | "database" | "llm-runtime"

/**
 * Creates log reporters that record what they receive.
 *
 * @returns Reporters whose calls each case can inspect.
 */
function createLogReporters() {
  const llmRuntime = {
    reportLlmRuntimeAcquisitionFailure: vi.fn(),
    reportLlmRuntimeAvailabilityCheckFailure: vi.fn()
  } satisfies LlmRuntimeFailureReporters
  const pageRendering = { reportPageReaderFailure: vi.fn() }
  const lmStudioSdk = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
  return {
    llmRuntime,
    pageRendering,
    lmStudioSdk,
    reportMcpServerEvent: vi.fn()
  } satisfies SingletonLogReporters
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
 * Builds a turn that says `Hello` to `qwen/qwen3-8b` without history,
 * sources, or tools.
 *
 * @returns The turn: it accepts the reply's final state, its part writes
 * are spies that store nothing, which the turn contract reads as a refused
 * write, and its senders and reporters are spies. The cases that use it read
 * only what the model was sent.
 */
function buildHelloAgentTurn(): AgentTurn {
  return {
    conversationId: createFixtureUuidV7(1),
    requestId: createFixtureUuidV7(2),
    trainedForToolUse: false,
    history: [],
    sources: [],
    userMessage: createUserMessage(1, "Hello"),
    canSeeImages: false,
    findAttachmentImage: vi.fn(),
    model: "qwen/qwen3-8b",
    generationOptions: { temperature: 0.4 },
    clientTools: [],
    builtInTools: [],
    mcpTools: [],
    unofferedTools: NO_UNOFFERED_TOOLS,
    abortSignal: new AbortController().signal,
    updateAssistantMessageState: () => true,
    createReplyPart: vi.fn(),
    updateReplyPartContent: vi.fn(),
    updateReplyToolCall: vi.fn(),
    sendEvent: vi.fn(),
    sendClientToolCall: vi.fn(),
    createToolCallGate: vi.fn(),
    reportReplyCancellation: vi.fn(),
    reportReplyRefusal: vi.fn(),
    reportReplyFailure: vi.fn()
  }
}

/**
 * Creates factories returning real services with recorded cleanup.
 *
 * @returns The factory mocks, their acquisitions, and the cleanup log.
 * @remarks The database is in memory and closed when the test finishes, and the
 * LLM runtime service is never connected: its provider lookup and runtime
 * acquisition reject if anything attempts them, and the chat service finds no
 * endpoint. No external resource is acquired.
 */
function createRecordedFactories() {
  const closeLog: AcquisitionName[] = []
  const database = SqliteDatabase.open(":memory:")
  onTestFinished(() => {
    database[Symbol.dispose]()
  })
  const acquisitions = {
    chat: createAcquisition(
      new ChatService({
        findChatEndpoint: () => undefined,
        titleGenerationPrompt: "prompt",
        generatedTitleMaxLength: 10
      }),
      "chat",
      closeLog
    ),
    database: createAcquisition(database, "database", closeLog),
    llmRuntime: createAcquisition(
      new LlmRuntimeService({
        ...createLogReporters().llmRuntime,
        findLlmProviderAccess: async () => {
          throw new Error("Unexpected provider lookup")
        },
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
    createLlmRuntimeService: vi.fn<
      SingletonServiceFactories["createLlmRuntimeService"]
    >(() => acquisitions.llmRuntime)
  }
  return { factories, acquisitions, closeLog }
}

describe("createSingletonServices", () => {
  it("derives each acquisition from the configuration", async () => {
    const { factories } = createRecordedFactories()
    const reporters = createLogReporters()

    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      reporters,
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(factories.createChatService).toHaveBeenCalledWith({
      findChatEndpoint: expect.any(Function),
      titleGenerationPrompt: TEST_BACKEND_CONFIG.titleGenerationPrompt,
      generatedTitleMaxLength: TEST_BACKEND_CONFIG.generatedTitleMaxLength
    })
    expect(factories.createDatabase).toHaveBeenCalledWith(
      TEST_BACKEND_CONFIG.databaseFilePath
    )
    expect(factories.createLlmRuntimeService).toHaveBeenCalledWith(
      TEST_BACKEND_CONFIG.settingsFilePath,
      reporters.llmRuntime,
      reporters.lmStudioSdk
    )
  })

  it("gives the chat service the endpoint of the provider the runtime service connected", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const apiKey = groqApiKeySchema.parse("gsk_synthetic_0123456789")
    const llmRuntimeService = new LlmRuntimeService({
      ...createLogReporters().llmRuntime,
      findLlmProviderAccess: async () => ({ provider: "groq", apiKey }),
      acquireLlmRuntime: async () =>
        createAcquiredFakeLlmRuntime(createFakeLlmRuntime(), "provider")
    })
    factories.createLlmRuntimeService.mockReturnValue(
      createAcquisition(llmRuntimeService, "llm-runtime", closeLog)
    )
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    onTestFinished(async () => await llmRuntimeService[Symbol.asyncDispose]())
    const findChatEndpoint =
      factories.createChatService.mock.lastCall?.[0].findChatEndpoint

    expect(findChatEndpoint?.()).toBeUndefined()
    await llmRuntimeService.connectLlmRuntime()

    expect(findChatEndpoint?.()).toEqual({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey,
      replyCeilingField: "max_completion_tokens"
    })
  })

  it("lists read_page, then web_search found by the bundle's web search tool provider", async () => {
    const { factories } = createRecordedFactories()

    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(services.builtInTools.map((entry) => entry.definition.name)).toEqual(
      ["read_page", "web_search"]
    )
    expect(services.builtInTools[1]?.provider).toBe(
      services.webSearchToolProvider
    )
    expect(await services.webSearchToolProvider.findTurnTool()).toEqual({
      status: "unavailable",
      reason: "api-key-missing"
    })
  })

  it("offers read_page once vmo at the configured host and port answers its health route", async () => {
    const { factories } = createRecordedFactories()
    const vmo = await startVmoServer(
      answerWithBody(200, "text/plain; charset=utf-8", "ok\n")
    )
    const vmoPort = Number(new URL(vmo.origin).port)

    const services = await createSingletonServices(
      { ...TEST_BACKEND_CONFIG, vmoPort },
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(
      await services.builtInTools[0]?.provider.findTurnTool()
    ).toMatchObject({ status: "ready" })
    expect(vmo.receivedRequests).toMatchObject([
      { method: "GET", path: "/health" }
    ])
  })

  it("decides tool approvals from the Just run choices in the configured settings file", async () => {
    const { factories } = createRecordedFactories()
    const settingsFilePath = await writeSettingsFile(
      JSON.stringify({ tools: { justRun: ["read_page"] } })
    )
    const sendToolApprovalPrompt = vi.fn(async () => ({
      status: "allowed" as const
    }))

    const services = await createSingletonServices(
      { ...TEST_BACKEND_CONFIG, settingsFilePath },
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    const gate = await services.toolApprovalService.createToolCallGate(
      sendToolApprovalPrompt,
      vi.fn()
    )

    const pageCall = {
      id: createFixtureUuidV7(1),
      toolName: "read_page",
      arguments: { url: "https://example.com/" }
    }
    const searchCall = {
      id: createFixtureUuidV7(2),
      toolName: "web_search",
      arguments: { query: "lys" }
    }

    expect(gate.startToolCall(pageCall, () => true).status).toBe("allowed")
    expect(gate.startToolCall(searchCall, () => true).status).toBe("prompted")
    expect(sendToolApprovalPrompt.mock.calls).toEqual([[searchCall]])
  })

  it("returns a frozen bundle of the services", async () => {
    const { factories, acquisitions } = createRecordedFactories()

    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(Object.isFrozen(services)).toBe(true)
    expect(services.chatService).toBe(acquisitions.chat.service)
    expect(services.conversationTurns).toBeInstanceOf(StoredConversationTurns)
    expect(services.replyParts).toBeInstanceOf(StoredReplyParts)
    expect(services.conversationHistoryReader).toBeInstanceOf(
      StoredConversationHistoryReader
    )
    expect(services.conversationHistoryEditor).toBeInstanceOf(
      StoredConversationHistoryEditor
    )
    expect(services.agentService).toBeInstanceOf(AgentService)
    expect(services.agentRuntimeService).toBeInstanceOf(AgentRuntimeService)
    expect(services.llmRuntimeService).toBe(acquisitions.llmRuntime.service)
    expect(services.llmService).toBeInstanceOf(LlmService)
    expect(services.attachmentFileStore).toBeInstanceOf(AttachmentFileStore)
  })

  it("creates the conversation adapters over the acquired database", async () => {
    const { factories, acquisitions } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    const turn = services.conversationTurns.createConversationTurn({
      conversation: createNewConversationTarget("caliginia"),
      userMessage: createTurnUserMessage("Hello"),
      model: "qwen/qwen3-8b"
    })
    services.conversationHistoryEditor.updateConversationTitle(
      turn.conversation.id,
      "Greeting"
    )
    const part = services.replyParts.createReplyPart(turn.assistantMessage.id, {
      kind: "text",
      round: 0,
      content: "Hi"
    })

    expect(
      services.conversationHistoryReader.getConversation(turn.conversation.id)
    ).toMatchObject({
      title: "Greeting",
      messages: [turn.userMessage, { parts: [part] }]
    })
    acquisitions.database.service[Symbol.dispose]()
    expect(() =>
      services.conversationHistoryReader.getConversation(turn.conversation.id)
    ).toThrow("Database is closed")
  })

  it("creates the agent service over the acquired database", async () => {
    const { factories, acquisitions } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    services.agentService.createAgent({
      code: "researcher",
      name: "Researcher",
      bio: "Searches the web.",
      systemPrompt: "You research the web."
    })

    expect(services.agentService.findAgent("researcher")).toMatchObject({
      agent: { kind: "custom", name: "Researcher" },
      deletedAt: null
    })
    acquisitions.database.service[Symbol.dispose]()
    expect(() => services.agentService.findAgent("researcher")).toThrow(
      "Database is closed"
    )
  })

  it.each([
    ["caliginia", TEST_BACKEND_CONFIG.caliginiaSystemPrompt],
    ["lysiptera", TEST_BACKEND_CONFIG.lysipteraSystemPrompt]
  ])(
    "builds the built-in agent %s from its configured prompt over the acquired chat and LLM services",
    async (agentCode, systemPrompt) => {
      const { factories, acquisitions } = createRecordedFactories()
      const services = await createSingletonServices(
        TEST_BACKEND_CONFIG,
        createLogReporters(),
        factories
      )
      onTestFinished(async () => await closeSingletonServices(services))
      const engine = createFakeLlmRuntime()
      engine.findLlmContextMeasurement.mockImplementation(
        async (_model, texts) => ({
          contextLength: 1_000_000,
          textTokenCounts: texts.map(() => 1)
        })
      )
      vi.spyOn(
        acquisitions.llmRuntime.service,
        "handleLlmEngineOperationRequest"
      ).mockImplementation(
        async (operation) =>
          await operation(createConnectedFakeLlmEngine(engine))
      )
      const completeChatStream = vi
        .spyOn(acquisitions.chat.service, "completeChatStream")
        .mockRejectedValue(new Error("model not loaded"))

      await services.agentRuntimeService
        .loadChatAgent(agentCode)
        ?.createReply(buildHelloAgentTurn())

      expect(engine.findLlmContextMeasurement).toHaveBeenCalledWith(
        "qwen/qwen3-8b",
        [systemPrompt, "Hello"]
      )
      expect(completeChatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Hello" }
          ]
        })
      )
    }
  )

  it("serves the LLM service through the runtime service's operation queue", async () => {
    const { factories, acquisitions } = createRecordedFactories()
    const refusal = new Error("The LLM runtime is closed.")
    const handleLlmEngineOperationRequest = vi
      .spyOn(acquisitions.llmRuntime.service, "handleLlmEngineOperationRequest")
      .mockRejectedValue(refusal)
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    await expect(services.llmService.listLlmModels()).rejects.toBe(refusal)

    expect(handleLlmEngineOperationRequest).toHaveBeenCalledOnce()
  })

  it("acquires nothing else when the database cannot be opened", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const creationFailure = new Error("unable to open database file")
    factories.createDatabase.mockImplementation(() => {
      throw creationFailure
    })

    await expect(
      createSingletonServices(
        TEST_BACKEND_CONFIG,
        createLogReporters(),
        factories
      )
    ).rejects.toBe(creationFailure)

    expect(closeLog).toEqual([])
    expect(factories.createLlmRuntimeService).not.toHaveBeenCalled()
    expect(factories.createChatService).not.toHaveBeenCalled()
  })

  it("releases the database when the conversation adapters cannot be created", async () => {
    const { factories, acquisitions, closeLog } = createRecordedFactories()
    acquisitions.database.service[Symbol.dispose]()

    await expect(
      createSingletonServices(
        TEST_BACKEND_CONFIG,
        createLogReporters(),
        factories
      )
    ).rejects.toThrow("Database is closed")

    expect(closeLog).toEqual(["database"])
    expect(factories.createLlmRuntimeService).not.toHaveBeenCalled()
  })

  it("releases the database when the LLM runtime service cannot be created", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const creationFailure = new Error("LLM runtime service construction failed")
    factories.createLlmRuntimeService.mockImplementation(() => {
      throw creationFailure
    })

    await expect(
      createSingletonServices(
        TEST_BACKEND_CONFIG,
        createLogReporters(),
        factories
      )
    ).rejects.toBe(creationFailure)

    expect(closeLog).toEqual(["database"])
    expect(factories.createChatService).not.toHaveBeenCalled()
  })

  it("releases earlier acquisitions in reverse order when the chat service cannot be created", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const creationFailure = new Error("Chat service construction failed")
    factories.createChatService.mockImplementation(() => {
      throw creationFailure
    })

    await expect(
      createSingletonServices(
        TEST_BACKEND_CONFIG,
        createLogReporters(),
        factories
      )
    ).rejects.toBe(creationFailure)

    expect(closeLog).toEqual(["llm-runtime", "database"])
  })

  it("keeps both failures when releasing earlier acquisitions also fails", async () => {
    const { factories, acquisitions, closeLog } = createRecordedFactories()
    const creationFailure = new Error("Chat service construction failed")
    const cleanupFailure = new Error("database is locked")
    factories.createChatService.mockImplementation(() => {
      throw creationFailure
    })
    acquisitions.database.closeService.mockRejectedValue(cleanupFailure)

    const failure = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({
      errors: [creationFailure, cleanupFailure]
    })
    expect(closeLog).toEqual(["llm-runtime"])
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
    const services = await createSingletonServices(config, createLogReporters())
    onTestFinished(async () => await closeSingletonServices(services))
    const history = services.conversationHistoryReader
    const turn = services.conversationTurns.createConversationTurn({
      conversation: createNewConversationTarget("caliginia"),
      userMessage: createTurnUserMessage("Hello"),
      model: "qwen/qwen3-8b"
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
      createLogReporters(),
      recorded.factories
    )
    return { services, ...recorded }
  }

  it("releases every acquisition in reverse acquisition order", async () => {
    const { services, closeLog } = await createRecordedServices()

    await closeSingletonServices(services)

    expect(closeLog).toEqual(["chat", "llm-runtime", "database"])
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

    expect(closeLog).toEqual(["chat", "database"])
    await expect(closeSingletonServices(services)).rejects.toBe(releaseFailure)
    expect(acquisitions.llmRuntime.closeService).toHaveBeenCalledOnce()
  })
})
