import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ActivityEvent } from "@lys/protocol"
import { groqApiKeySchema, type ConversationAttachmentDraft } from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { backendConfigSchema } from "../../../src/config"
import ActivityHub from "../../../src/modules/activity/activityHub"
import type { AgentTurn } from "../../../src/modules/agent/agent"
import AgentRuntimeService from "../../../src/modules/agent/agentRuntimeService"
import AgentService from "../../../src/modules/agent/agentService"
import { NO_UNOFFERED_TOOLS } from "../../../src/modules/agent/unofferedTools"
import ChatService from "../../../src/modules/chat/chatService"
import type { ConversationTurn } from "../../../src/modules/chat/persistence"
import type ReplyGeneration from "../../../src/modules/chat/replyGeneration"
import ReplyGenerationRegistry, {
  type ReplyTarget
} from "../../../src/modules/chat/replyGenerationRegistry"
import type { TurnSettings } from "../../../src/modules/chat/turnStart"
import StoredConversationHistoryEditor from "../../../src/modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../../../src/modules/conversation/historyReader"
import AttachmentFileStore from "../../../src/modules/attachment/attachmentFileStore"
import StoredReplyParts from "../../../src/modules/conversation/replyParts"
import StoredConversationTurns from "../../../src/modules/conversation/turns"
import ConversationWakeSettings from "../../../src/modules/delegation/conversationWakeSettings"
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
import { createBackendLogger } from "../../../src/log"
import { TitleGenerationOutputError } from "../../../src/utils/errors"
import { TEST_BACKEND_CONFIG } from "../support/backendConfig"
import ControlledReplyTask from "../support/controlledReplyTask"
import {
  createFixtureUuidV7,
  createNewConversationTarget,
  createTurnUserMessage,
  createUserMessage
} from "../support/conversationFixtures"
import {
  createJobMessageDraft,
  createPersonTurn,
  FIRST_MEMBER_DEFINITION,
  MOTHS_REQUEST,
  waitForFirstJobReplyEnd
} from "../support/delegationTestServices"
import {
  createAcquiredFakeLlmRuntime,
  createConnectedFakeLlmEngine,
  createFakeLlmRuntime
} from "../support/fakeLlmRuntime"
import { CapturedLogDestination } from "../support/fastifyTestApp"
import { waitForMicrotasks } from "../support/microtasks"
import { createChatCompletionChunk } from "../support/openAiEndpointFake"
import { writeSettingsFile } from "../support/settingsFile"
import { createSettlementReader } from "../support/settlement"
import { READ_TEXT_FILE_TOOL } from "../support/toolFixtures"
import {
  NO_TURN_DELEGATION,
  NO_TURN_DELEGATION_HOOKS
} from "../support/turnDelegationFakes"
import { answerWithBody, startVmoServer } from "../support/vmoServer"

// The bundle imports the LM Studio SDK through its runtime adapter. No case
// connects the runtime, so no case arranges the fake engine.
vi.mock("@lmstudio/sdk", () => import("../support/lmStudioSdkFake"))

/** Name of each acquisition whose release the bundle owns. */
type AcquisitionName = "chat" | "database" | "llm-runtime"

/** Model that every turn a case starts through a bundle names. */
const TURN_MODEL = "qwen/qwen3-8b"

/**
 * Settings of a turn that offers no tools, for a model that sees no images
 * and is not trained for tool use.
 */
const PLAIN_TURN_SETTINGS: TurnSettings = Object.freeze({
  model: TURN_MODEL,
  generationOptions: Object.freeze({ temperature: 0.4 }),
  clientTools: Object.freeze([]),
  builtInTools: Object.freeze([]),
  mcpTools: Object.freeze([]),
  offersDelegateWork: false,
  unofferedTools: NO_UNOFFERED_TOOLS,
  canSeeImages: false,
  trainedForToolUse: false
})

/** Attachments of a turn whose message carries none. */
const NO_ATTACHMENTS: readonly ConversationAttachmentDraft[] = Object.freeze([])

/** A photo the person attached, before its conversation numbers it. */
const PHOTO_ATTACHMENT: ConversationAttachmentDraft = Object.freeze({
  kind: "image",
  name: "photo.png",
  sizeBytes: 33,
  mediaType: "image/png",
  width: 64,
  height: 32
})

/** Reply a case registers a generation for; no conversation stores it. */
const UNSTORED_REPLY_TARGET: ReplyTarget = Object.freeze({
  conversationId: createFixtureUuidV7(1),
  assistantMessageId: createFixtureUuidV7(2)
})

/** A turn a case started through a bundle's turn start. */
type StartedTurn = Readonly<{
  /** The stored turn. */
  turn: ConversationTurn
  /** Generation the turn start returned for the turn. */
  generation: ReplyGeneration
}>

/**
 * Name of each service whose close the cleanup log records: the
 * acquisitions, the two tool services that own resources, and the activity
 * hub.
 */
type ClosedServiceName =
  | AcquisitionName
  | "activity-hub"
  | "email-account-checker"
  | "mcp-server-registry"

/**
 * Creates log reporters that record what they receive.
 *
 * @returns Reporters whose calls each case can inspect, and a logger of the
 * backend's own turns that writes to a destination no case reads.
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
    reportMcpServerEvent: vi.fn(),
    reportMcpProcessGroupsSaveFailure: vi.fn(),
    sendEmailAccountCheckEvent: vi.fn(),
    reportDelegationEvent: vi.fn(),
    backendTurnLogger: createBackendLogger(new CapturedLogDestination())
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
  closeLog: ClosedServiceName[]
) {
  return {
    service,
    closeService: vi.fn(async () => {
      closeLog.push(name)
    })
  } satisfies SingletonServiceAcquisition<Service>
}

/**
 * Updates a service the bundle created so that each of its closes is logged
 * under `name` before the close goes on.
 *
 * @param service - Service whose close is recorded; its close completes at
 * once or returns its completion.
 * @param name - Name recorded when the close starts.
 * @param closeLog - Shared log of cleanup calls in call order.
 */
function updateServiceClose(
  service: Readonly<{ close: () => void | Promise<void> }>,
  name: ClosedServiceName,
  closeLog: ClosedServiceName[]
): void {
  const close = service.close.bind(service)
  vi.spyOn(service, "close").mockImplementation(async () => {
    closeLog.push(name)
    await close()
  })
}

/**
 * Builds a turn that says `Hello` to `qwen/qwen3-8b` without history,
 * sources, or tools.
 *
 * @param requestId - Reply the turn writes; a fixed reply by default.
 * @returns The turn: it finds its reply still streaming and accepts the
 * reply's final state, its part writes
 * are spies that store nothing, which the turn contract reads as a refused
 * write, and its senders and reporters are spies. The cases that use it read
 * only what the model was sent, or how the reply was reported.
 */
function buildHelloAgentTurn(
  requestId: string = createFixtureUuidV7(2)
): AgentTurn {
  return {
    conversationId: createFixtureUuidV7(1),
    requestId,
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
    delegation: NO_TURN_DELEGATION,
    abortSignal: new AbortController().signal,
    updateAssistantMessageState: () => true,
    findReplyStatus: () => "streaming",
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
  const closeLog: ClosedServiceName[] = []
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

/**
 * Creates the stream of a model that replies `Hi` and stops.
 *
 * @returns A stream of one chunk.
 */
async function* createHiReplyStream() {
  yield createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
}

/**
 * Creates the stream of a model that calls the client tool `read_text_file`
 * and ends its round for the call's result.
 *
 * @returns A stream of the call, then the finish that hands it over.
 */
async function* createFileReadCallStream() {
  yield createChatCompletionChunk({
    toolCalls: [
      {
        index: 0,
        id: "call_0",
        type: "function",
        function: { name: "read_text_file", arguments: '{"path":"/notes.md"}' }
      }
    ]
  })
  yield createChatCompletionChunk({ finishReason: "tool_calls" })
}

/**
 * Creates spies in place of the model calls that a turn of a bundle makes.
 *
 * @param services - Bundle whose LLM service and chat service are spied on.
 * @returns The spies. Every model is loaded with a context of 1,000,000
 * tokens, in which each text counts one token; every reply is `Hi`; and a
 * title request rejects until a case configures it.
 */
function createModelSpies(
  services: Pick<SingletonServices, "llmService" | "chatService">
) {
  const findLlmContextMeasurement = vi
    .spyOn(services.llmService, "findLlmContextMeasurement")
    .mockImplementation(async (_model, texts) => ({
      contextLength: 1_000_000,
      textTokenCounts: texts.map(() => 1)
    }))
  const completeChatStream = vi
    .spyOn(services.chatService, "completeChatStream")
    .mockImplementation(async () => createHiReplyStream())
  const generateTitle = vi
    .spyOn(services.chatService, "generateTitle")
    .mockRejectedValue(new Error("Unexpected title request"))
  return { findLlmContextMeasurement, completeChatStream, generateTitle }
}

/**
 * Starts a person's turn that says `Hello` in a new conversation through a
 * bundle's turn start, for the bundle's live Caliginia to answer.
 *
 * @param services - Bundle whose conversation turns, live agents, and turn
 * start the turn goes through.
 * @param settings - Model, controls, and tools the turn is started with.
 * @param attachments - Attachments of the turn's message; no file is written
 * for them.
 * @returns The stored turn and its generation, which is already running,
 * takes no part in delegation, and logs to a destination no case reads.
 * @throws If Caliginia is not live.
 */
function startHelloTurn(
  services: Pick<
    SingletonServices,
    "conversationTurns" | "agentRuntimeService" | "startTurn"
  >,
  settings: TurnSettings,
  attachments: readonly ConversationAttachmentDraft[]
): StartedTurn {
  const agent = services.agentRuntimeService.loadChatAgent("caliginia")
  if (agent === undefined) throw new Error("Caliginia is not live")
  const turn = services.conversationTurns.createConversationTurn({
    conversation: createNewConversationTarget("caliginia"),
    userMessage: { ...createTurnUserMessage("Hello"), attachments },
    model: TURN_MODEL
  })
  const generation = services.startTurn({
    turn,
    agent,
    settings,
    startedBy: "person",
    delegation: NO_TURN_DELEGATION_HOOKS,
    logger: createBackendLogger(new CapturedLogDestination())
  })
  return { turn, generation }
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
    expect(services.replyGenerations).toBeInstanceOf(ReplyGenerationRegistry)
    expect(services.activityHub).toBeInstanceOf(ActivityHub)
    expect(services.conversationWakeSettings).toBeInstanceOf(
      ConversationWakeSettings
    )
    expect(services.turnDelegations).toEqual({
      handleTurnStarted: expect.any(Function),
      createTurnDelegation: expect.any(Function),
      handleReplyEnded: expect.any(Function)
    })
  })

  it("gives a member work through the bundle's delegation hooks: the job's turn is stored, answered by the member, and reported", async () => {
    const { factories } = createRecordedFactories()
    const reporters = createLogReporters()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      reporters,
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    createModelSpies(services)
    services.agentService.createAgent(FIRST_MEMBER_DEFINITION)
    const delegating = createPersonTurn(services.conversationTurns)
    const conversationId = delegating.turn.conversation.id
    const draft = createJobMessageDraft(
      services.replyParts,
      delegating,
      MOTHS_REQUEST
    )
    const delegation = services.turnDelegations.createTurnDelegation(delegating)

    const outcome = delegation.createJobMessage(draft)
    const job = await waitForFirstJobReplyEnd(services, conversationId)

    expect(outcome).toEqual({
      status: "sent",
      jobNumber: 1,
      agentName: "Researcher",
      title: "Moths",
      isNewJob: true
    })
    expect(job.state).toBe("replied")
    expect(
      services.conversationHistoryReader.getConversation(job.id)
    ).toMatchObject({
      parentConversationId: conversationId,
      messages: [
        { role: "user", content: "Find what moths eat", origin: "delegator" },
        { id: job.replyId, status: "completed", parts: [{ content: "Hi" }] }
      ]
    })
    expect(reporters.reportDelegationEvent).toHaveBeenCalledExactlyOnceWith({
      kind: "job-message-sent",
      conversationId,
      jobId: job.id,
      jobNumber: 1,
      agentCode: "researcher",
      isNewJob: true
    })
  })

  it("starts a person's turn in the bundle's reply generation registry and stores its reply and generated title on the acquired database", async () => {
    const { factories } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    const model = createModelSpies(services)
    model.generateTitle.mockResolvedValue("Greeting")

    const { turn, generation } = startHelloTurn(
      services,
      PLAIN_TURN_SETTINGS,
      NO_ATTACHMENTS
    )
    const registered = services.replyGenerations.findReplyGeneration({
      conversationId: turn.conversation.id,
      assistantMessageId: turn.assistantMessage.id
    })
    await generation.settled

    expect(registered).toBe(generation)
    expect(
      services.conversationHistoryReader.getConversation(turn.conversation.id)
    ).toMatchObject({
      title: "Greeting",
      messages: [
        turn.userMessage,
        { status: "completed", parts: [{ kind: "text", content: "Hi" }] }
      ]
    })
  })

  it("requests a turn's title once the LLM service finds the model loaded, without measuring a text", async () => {
    const { factories } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    const model = createModelSpies(services)
    model.generateTitle.mockResolvedValue("Greeting")

    const { generation } = startHelloTurn(
      services,
      PLAIN_TURN_SETTINGS,
      NO_ATTACHMENTS
    )
    await generation.settled

    expect(model.findLlmContextMeasurement).toHaveBeenCalledWith(TURN_MODEL, [])
    expect(model.generateTitle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Hello", model: TURN_MODEL })
    )
  })

  it("requests no title while the LLM service finds the turn's model not loaded", async () => {
    const { factories } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    const model = createModelSpies(services)
    model.findLlmContextMeasurement.mockResolvedValue(undefined)

    const { generation } = startHelloTurn(
      services,
      PLAIN_TURN_SETTINGS,
      NO_ATTACHMENTS
    )
    await generation.settled

    expect(model.findLlmContextMeasurement).toHaveBeenCalledWith(TURN_MODEL, [])
    expect(model.generateTitle).not.toHaveBeenCalled()
  })

  it("requests a turn's title at most the configured number of times", async () => {
    const { factories } = createRecordedFactories()
    const services = await createSingletonServices(
      { ...TEST_BACKEND_CONFIG, titleGenerationMaxAttempts: 3 },
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    const model = createModelSpies(services)
    model.generateTitle.mockRejectedValue(
      new TitleGenerationOutputError("The model wrote no usable title")
    )

    const { generation } = startHelloTurn(
      services,
      PLAIN_TURN_SETTINGS,
      NO_ATTACHMENTS
    )
    await generation.settled

    expect(model.generateTitle).toHaveBeenCalledTimes(3)
  })

  it("reads a turn's image from the bundle's attachment file store for a model that sees images", async () => {
    const { factories } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    const model = createModelSpies(services)
    model.generateTitle.mockResolvedValue("Greeting")
    const readAttachment = vi.spyOn(
      services.attachmentFileStore,
      "readAttachment"
    )

    const { turn, generation } = startHelloTurn(
      services,
      { ...PLAIN_TURN_SETTINGS, canSeeImages: true },
      [PHOTO_ATTACHMENT]
    )
    await generation.settled

    expect(readAttachment).toHaveBeenCalledWith({
      conversationId: turn.conversation.id,
      messageId: turn.userMessage.id,
      name: "photo.png"
    })
  })

  it("asks the person through the bundle's tool approval service before a turn's tool call runs", async () => {
    const { factories } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    const model = createModelSpies(services)
    model.generateTitle.mockResolvedValue("Greeting")
    model.completeChatStream.mockImplementation(async () =>
      createFileReadCallStream()
    )
    const createToolCallGate = vi.spyOn(
      services.toolApprovalService,
      "createToolCallGate"
    )

    const { generation } = startHelloTurn(
      services,
      { ...PLAIN_TURN_SETTINGS, clientTools: [READ_TEXT_FILE_TOOL] },
      NO_ATTACHMENTS
    )
    await vi.waitFor(() => {
      expect(generation.pendingToolCalls.toolApprovals).toHaveLength(1)
    })

    expect(createToolCallGate).toHaveBeenCalledOnce()
    expect(generation.pendingToolCalls.toolApprovals).toMatchObject([
      { toolName: "read_text_file", arguments: { path: "/notes.md" } }
    ])
  })

  it("answers a turn that waited in its agent's line, finding its reply still streaming in the stored conversation", async () => {
    const { factories } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    const model = createModelSpies(services)
    model.generateTitle.mockResolvedValue("Greeting")
    const release = Promise.withResolvers<void>()
    model.completeChatStream.mockImplementation(async () => {
      await release.promise
      return createHiReplyStream()
    })
    const { agentRequestSlotCount } = TEST_BACKEND_CONFIG
    for (let held = 0; held < agentRequestSlotCount; held += 1)
      startHelloTurn(services, PLAIN_TURN_SETTINGS, NO_ATTACHMENTS)

    const { turn, generation } = startHelloTurn(
      services,
      PLAIN_TURN_SETTINGS,
      NO_ATTACHMENTS
    )
    await vi.waitFor(() => {
      expect(model.completeChatStream).toHaveBeenCalledTimes(
        agentRequestSlotCount
      )
    })
    release.resolve()
    await generation.settled

    expect(
      services.conversationHistoryReader.getConversation(turn.conversation.id)
    ).toMatchObject({
      messages: [turn.userMessage, { status: "completed" }]
    })
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

  it("gives every live agent the configured request slots and waiting line", async () => {
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
      async (operation) => await operation(createConnectedFakeLlmEngine(engine))
    )
    const release = Promise.withResolvers<void>()
    vi.spyOn(
      acquisitions.chat.service,
      "completeChatStream"
    ).mockImplementation(async () => {
      await release.promise
      throw new Error("model not loaded")
    })
    const agent = services.agentRuntimeService.loadChatAgent("caliginia")
    if (agent === undefined) throw new Error("Caliginia is not live")
    const { agentRequestSlotCount, agentWaitingRequestLimit } =
      TEST_BACKEND_CONFIG
    const accepted = Array.from(
      { length: agentRequestSlotCount + agentWaitingRequestLimit },
      (_unused, index) =>
        agent.createReply(buildHelloAgentTurn(createFixtureUuidV7(20 + index)))
    )
    const refusedTurn = buildHelloAgentTurn(createFixtureUuidV7(30))

    await agent.createReply(refusedTurn)
    const outcome = services.agentRuntimeService.findAgentState(
      { code: "caliginia", role: "leader" },
      "caliginia"
    )
    release.resolve()
    await Promise.all(accepted)

    expect(outcome).toMatchObject({
      status: "found",
      state: { requestSlotCount: agentRequestSlotCount }
    })
    expect(
      outcome.status === "found" &&
        outcome.state.requests.filter(
          (request) => request.step.kind === "waiting"
        ).length
    ).toBe(agentWaitingRequestLimit)
    expect(refusedTurn.reportReplyRefusal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        limits: {
          slotCount: agentRequestSlotCount,
          waitingLimit: agentWaitingRequestLimit
        }
      })
    )
  })

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

  it("closes the activity hub, then ends every running reply generation, before it closes the MCP server registry or releases an acquisition, and leaves the reply generation registry closed", async () => {
    const { services, closeLog } = await createRecordedServices()
    updateServiceClose(services.activityHub, "activity-hub", closeLog)
    const closeMcpServerRegistry = vi.spyOn(services.mcpServerRegistry, "close")
    const replyTask = new ControlledReplyTask()
    services.replyGenerations.startReplyGeneration(UNSTORED_REPLY_TARGET, {
      startReplyTask: (context) => replyTask.start(context),
      startTitleTask: undefined,
      reportTaskFailure: vi.fn()
    })
    onTestFinished(() => {
      replyTask.resolve()
    })
    // The reply task starts here, so the case can observe what was closed
    // at the moment the cleanup cancels it.
    await waitForMicrotasks()
    let closedBeforeCancellation: readonly ClosedServiceName[] | undefined =
      undefined
    replyTask.context.abortSignal.addEventListener(
      "abort",
      () => {
        closedBeforeCancellation = [...closeLog]
      },
      { once: true }
    )

    const closing = closeSingletonServices(services)
    await waitForMicrotasks()
    const closedWhileGenerating = {
      isReplyCancelled: replyTask.context.abortSignal.aborted,
      mcpServerRegistryCloseCount: closeMcpServerRegistry.mock.calls.length,
      closedServices: [...closeLog]
    }
    replyTask.resolve()
    await closing

    expect(closedBeforeCancellation).toEqual(["activity-hub"])
    expect(closedWhileGenerating).toEqual({
      isReplyCancelled: true,
      mcpServerRegistryCloseCount: 0,
      closedServices: ["activity-hub"]
    })
    expect(closeMcpServerRegistry).toHaveBeenCalledOnce()
    expect(closeLog).toEqual([
      "activity-hub",
      "chat",
      "llm-runtime",
      "database"
    ])
    expect(() =>
      services.replyGenerations.findReplyGeneration(UNSTORED_REPLY_TARGET)
    ).toThrow("Reply generation registry is closed")
  })

  it("ends the streams of the activity hub, which gives a later stream no event", async () => {
    const { services } = await createRecordedServices()
    const written: ActivityEvent[] = []
    const stream = services.activityHub.openStream(async (event) => {
      written.push(event)
    })
    const streamClosure = createSettlementReader(stream.closed)

    await closeSingletonServices(services)
    const lateStream = services.activityHub.openStream(async (event) => {
      written.push(event)
    })
    const lateStreamClosure = createSettlementReader(lateStream.closed)
    await waitForMicrotasks()

    expect(streamClosure()).toBe("fulfilled")
    expect(lateStreamClosure()).toBe("fulfilled")
    expect(written).toEqual([{ type: "activity-snapshot", replies: [] }])
  })

  it("closes the activity hub, then the email account checker, then the MCP server registry, before every acquisition", async () => {
    const { services, closeLog } = await createRecordedServices()
    updateServiceClose(services.activityHub, "activity-hub", closeLog)
    updateServiceClose(
      services.emailAccountChecker,
      "email-account-checker",
      closeLog
    )
    updateServiceClose(
      services.mcpServerRegistry,
      "mcp-server-registry",
      closeLog
    )

    await closeSingletonServices(services)

    expect(closeLog).toEqual([
      "activity-hub",
      "email-account-checker",
      "mcp-server-registry",
      "chat",
      "llm-runtime",
      "database"
    ])
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
