import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { ActivityEvent, MessageGenerationOptions } from "@lys/protocol"
import {
  ARMITAGE_AGENT_CODE,
  DELEGATE_WORK_TOOL_NAME,
  LLM_PROVIDERS,
  type ConversationAttachmentDraft,
  type LlmModelReference,
  type LlmProvider
} from "@lys/share"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { backendConfigSchema } from "../../../src/config"
import ActivityHub from "../../../src/modules/activity/activityHub"
import type { AgentTurn } from "../../../src/modules/agent/agent"
import AgentRuntimeService from "../../../src/modules/agent/agentRuntimeService"
import AgentService from "../../../src/modules/agent/agentService"
import type { JobMessageDraft } from "../../../src/modules/agent/turnDelegation"
import { NO_UNOFFERED_TOOLS } from "../../../src/modules/agent/unofferedTools"
import ChatService from "../../../src/modules/chat/chatService"
import type {
  ConversationTurn,
  ConversationTurnUserMessage
} from "../../../src/modules/chat/persistence"
import type ReplyGeneration from "../../../src/modules/chat/replyGeneration"
import ReplyGenerationRegistry, {
  type ReplyTarget
} from "../../../src/modules/chat/replyGenerationRegistry"
import type {
  TurnDelegationContext,
  TurnSettings
} from "../../../src/modules/chat/turnStart"
import StoredConversationHistoryEditor from "../../../src/modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../../../src/modules/conversation/historyReader"
import AttachmentFileStore from "../../../src/modules/attachment/attachmentFileStore"
import StoredReplyParts from "../../../src/modules/conversation/replyParts"
import StoredConversationTurns from "../../../src/modules/conversation/turns"
import ConversationWakeSettings from "../../../src/modules/delegation/conversationWakeSettings"
import { buildLlmChatEndpoint } from "../../../src/modules/llm/llmProviderAccess"
import {
  buildLlmProviderRecord,
  type LlmProviderRecord
} from "../../../src/modules/llm/llmProviderServices"
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
import {
  LM_STUDIO_QWEN3_8B,
  TEST_LLM_PROVIDER_ACCESSES
} from "../support/llmFixtures"
import { writeSettingsFile } from "../support/settingsFile"
import { createSettlementReader } from "../support/settlement"
import {
  READ_TEXT_FILE_TOOL,
  SEARCH_CALL_ID,
  TOOL_CALL_POLICY
} from "../support/toolFixtures"
import {
  NO_TURN_DELEGATION,
  NO_TURN_DELEGATION_HOOKS
} from "../support/turnDelegationFakes"
import { answerWithBody, startVmoServer } from "../support/vmoServer"

// The bundle imports the LM Studio SDK through its runtime adapter. No case
// connects the runtime, so no case arranges the fake engine.
vi.mock("@lmstudio/sdk", () => import("../support/lmStudioSdkFake"))

/**
 * Name of each acquisition whose release the bundle owns: one LLM runtime
 * service for each provider.
 */
type AcquisitionName = "chat" | "database" | `llm-runtime:${LlmProvider}`

/** Qwen 3 8B on Groq, a model on a provider other than LM Studio. */
const GROQ_QWEN3_8B: LlmModelReference = Object.freeze({
  provider: "groq",
  modelKey: "qwen/qwen3-8b"
})

/**
 * Names of the providers' LLM runtime acquisitions in acquisition order,
 * which is provider order.
 */
const LLM_RUNTIME_ACQUISITION_NAMES: readonly AcquisitionName[] =
  LLM_PROVIDERS.map((provider) => `llm-runtime:${provider}` as const)

/** Names of the providers' LLM runtime acquisitions in release order. */
const LLM_RUNTIME_RELEASE_NAMES: readonly AcquisitionName[] =
  LLM_RUNTIME_ACQUISITION_NAMES.toReversed()

/** Model that every turn a case starts through a bundle names. */
const TURN_MODEL = LM_STUDIO_QWEN3_8B

/** Sampling of the turn a case starts through a bundle. */
const PLAIN_GENERATION_OPTIONS: TurnSettings["generationOptions"] =
  Object.freeze({ temperature: 0.4 })

/**
 * Settings of a turn that offers no tools, for a model that sees no images
 * and is not trained for tool use.
 */
const PLAIN_TURN_SETTINGS: TurnSettings = Object.freeze({
  model: TURN_MODEL,
  generationOptions: PLAIN_GENERATION_OPTIONS,
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
 * acquisitions, the two tool services that own resources, the activity
 * hub, and delegation's wake settings.
 */
type ClosedServiceName =
  | AcquisitionName
  | "activity-hub"
  | "wake-settings"
  | "email-account-checker"
  | "mcp-server-registry"

/**
 * Creates log reporters that record what they receive.
 *
 * @returns Reporters whose calls each case can inspect, and a logger of the
 * backend's own turns that writes to a destination no case reads.
 */
function createLogReporters() {
  const llmRuntime = buildLlmProviderRecord(
    () =>
      ({
        reportLlmRuntimeAcquisitionFailure: vi.fn(),
        reportLlmRuntimeAvailabilityCheckFailure: vi.fn()
      }) satisfies LlmRuntimeFailureReporters
  )
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
 * Starts a generation for {@link UNSTORED_REPLY_TARGET} whose reply task stays
 * pending until the case settles it, without a title task.
 *
 * @param generations - Registry that admits the generation.
 * @returns The reply task. It begins after the current synchronous step, so
 * the case reads its context after a barrier such as `waitForMicrotasks`.
 * @remarks The reply task is resolved when the test finishes, so a case that
 * fails early does not leave the bundle's close waiting.
 */
function startControlledGeneration(
  generations: ReplyGenerationRegistry
): ControlledReplyTask {
  const replyTask = new ControlledReplyTask()
  generations.startReplyGeneration(UNSTORED_REPLY_TARGET, {
    startReplyTask: (context) => replyTask.start(context),
    startTitleTask: undefined,
    reportTaskFailure: vi.fn()
  })
  onTestFinished(() => {
    replyTask.resolve()
  })
  return replyTask
}

/**
 * Builds a turn that says `Hello` to a model without history, sources, or
 * tools.
 *
 * @param requestId - Reply the turn writes; a fixed reply by default.
 * @param model - Model the turn names; `qwen/qwen3-8b` on LM Studio by
 * default.
 * @returns The turn: it finds its reply still streaming and accepts the
 * reply's final state, its part writes
 * are spies that store nothing, which the turn contract reads as a refused
 * write, and its senders and reporters are spies. The cases that use it read
 * only what the model was sent, or how the reply was reported.
 */
function buildHelloAgentTurn(
  requestId: string = createFixtureUuidV7(2),
  model: LlmModelReference = LM_STUDIO_QWEN3_8B
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
    model,
    generationOptions: { temperature: 0.4 },
    directTools: [],
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
    toolCallPolicy: TOOL_CALL_POLICY,
    createToolCallGate: vi.fn(),
    reportReplyCancellation: vi.fn(),
    reportReplyRefusal: vi.fn(),
    reportReplyFailure: vi.fn(),
    reportToolSearchFailure: vi.fn()
  }
}

/**
 * Creates the acquisition of a provider's real LLM runtime service that is
 * never connected, with recorded cleanup.
 *
 * @param provider - Provider the service belongs to.
 * @param closeLog - Shared log of cleanup calls in call order.
 * @returns The acquisition, recorded as `llm-runtime:<provider>` when it is
 * released. The service's provider lookup and runtime acquisition reject if
 * anything attempts them.
 */
function createUnconnectedLlmRuntimeAcquisition(
  provider: LlmProvider,
  closeLog: ClosedServiceName[]
) {
  return createAcquisition(
    new LlmRuntimeService({
      ...createLogReporters().llmRuntime[provider],
      findLlmProviderAccess: async () => {
        throw new Error("Unexpected provider lookup")
      },
      acquireLlmRuntime: async () => {
        throw new Error("Unexpected LLM runtime acquisition")
      }
    }),
    `llm-runtime:${provider}`,
    closeLog
  )
}

/**
 * Updates an LLM runtime service so that it runs each engine operation on a
 * connected fake engine whose context measurement fits every turn: a context
 * of 1,000,000 tokens and one token for each measured text.
 *
 * @param runtimeService - Service whose engine operations change; the fake
 * engine's other operations reject as unexpected.
 */
function updateLlmEngineToFittingFake(runtimeService: LlmRuntimeService): void {
  const engine = createFakeLlmRuntime()
  engine.findLlmContextMeasurement.mockImplementation(
    async (_model, texts) => ({
      contextLength: 1_000_000,
      textTokenCounts: texts.map(() => 1)
    })
  )
  vi.spyOn(
    runtimeService,
    "handleLlmEngineOperationRequest"
  ).mockImplementation(
    async (operation) => await operation(createConnectedFakeLlmEngine(engine))
  )
}

/**
 * Builds an LLM runtime service factory that hands out the recorded
 * acquisition of each provider it is asked for, except one provider, whose
 * service cannot be created.
 *
 * @param acquisitions - Recorded acquisitions of the providers' services.
 * @param failingProvider - Provider whose service creation fails.
 * @param creationFailure - Error that creating that provider's service
 * throws.
 * @returns The factory.
 */
function buildLlmRuntimeServiceFactoryFailingFor(
  acquisitions: LlmProviderRecord<
    SingletonServiceAcquisition<LlmRuntimeService>
  >,
  failingProvider: LlmProvider,
  creationFailure: Error
): SingletonServiceFactories["createLlmRuntimeService"] {
  return ({ provider }) => {
    if (provider === failingProvider) throw creationFailure
    return acquisitions[provider]
  }
}

/**
 * Creates factories returning real services with recorded cleanup.
 *
 * @returns The factory mocks, their acquisitions, and the cleanup log; the
 * LLM runtime factory hands out the acquisition of the provider it is asked
 * for.
 * @remarks The database is in memory and closed when the test finishes, and no
 * provider's LLM runtime service is ever connected: its provider lookup and
 * runtime acquisition reject if anything attempts them, and the chat service
 * finds no endpoint. No external resource is acquired.
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
    llmRuntime: buildLlmProviderRecord((provider) =>
      createUnconnectedLlmRuntimeAcquisition(provider, closeLog)
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
    >(({ provider }) => acquisitions.llmRuntime[provider])
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
 * @param services - Bundle whose LM Studio LLM service, the one of
 * {@link TURN_MODEL}, and chat service are spied on.
 * @returns The spies. Every model is loaded with a context of 1,000,000
 * tokens, in which each text counts one token; every reply is `Hi`; and a
 * title request rejects until a case configures it.
 */
function createModelSpies(
  services: Pick<SingletonServices, "llmProviderServices" | "chatService">
) {
  const findLlmContextMeasurement = vi
    .spyOn(
      services.llmProviderServices.lmStudio.llmService,
      "findLlmContextMeasurement"
    )
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

/** A bundle whose member the lead's stored turn may give work. */
type DelegatingBundle = Readonly<{
  /** The bundle, closed when the test finishes. */
  services: SingletonServices
  /** Reporters the bundle was created with, which record what they receive. */
  reporters: ReturnType<typeof createLogReporters>
  /** The lead's stored turn, whose reply streams and has no generation. */
  delegating: TurnDelegationContext
  /** The job message the lead's turn sends the researcher about moths. */
  draft: JobMessageDraft
}>

/**
 * Creates a bundle that stores the researcher as a member, stores a turn of
 * the lead, and drafts the job message that turn sends the researcher.
 *
 * @returns The bundle, its reporters, the lead's turn, and the draft.
 * @remarks The bundle is created from recorded factories and closed when
 * the test finishes. Its model calls are spied on as
 * {@link createModelSpies} spies on them, so every reply is `Hi`.
 */
async function openDelegatingBundle(): Promise<DelegatingBundle> {
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
  const draft = createJobMessageDraft(
    services.replyParts,
    delegating,
    MOTHS_REQUEST
  )
  return Object.freeze({ services, reporters, delegating, draft })
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
  const userMessage: ConversationTurnUserMessage = {
    ...createTurnUserMessage("Hello"),
    attachments
  }
  const turn = services.conversationTurns.createConversationTurn({
    conversation: createNewConversationTarget("caliginia"),
    userMessage,
    model: TURN_MODEL
  })
  const generation = services.startTurn({
    turn,
    agent,
    settings,
    startedBy: "person",
    ...NO_TURN_DELEGATION_HOOKS,
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
    expect(factories.createLlmRuntimeService.mock.calls).toEqual(
      LLM_PROVIDERS.map((provider) => [
        {
          provider,
          settingsFilePath: TEST_BACKEND_CONFIG.settingsFilePath,
          llmRuntimeFailureReporters: reporters.llmRuntime[provider],
          lmStudioSdkLogger: reporters.lmStudioSdk
        }
      ])
    )
  })

  it("gives the chat service each provider's endpoint while that provider's runtime service is connected", async () => {
    const { factories, closeLog } = createRecordedFactories()
    const connectedRuntimeServices = buildLlmProviderRecord(
      (provider) =>
        new LlmRuntimeService({
          ...createLogReporters().llmRuntime[provider],
          findLlmProviderAccess: async () =>
            TEST_LLM_PROVIDER_ACCESSES[provider],
          acquireLlmRuntime: async () =>
            createAcquiredFakeLlmRuntime(createFakeLlmRuntime(), "provider")
        })
    )
    factories.createLlmRuntimeService.mockImplementation(({ provider }) =>
      createAcquisition(
        connectedRuntimeServices[provider],
        `llm-runtime:${provider}`,
        closeLog
      )
    )
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    for (const provider of LLM_PROVIDERS) {
      onTestFinished(
        async () =>
          await connectedRuntimeServices[provider][Symbol.asyncDispose]()
      )
    }
    const findChatEndpoint =
      factories.createChatService.mock.lastCall?.[0].findChatEndpoint

    expect(findChatEndpoint?.("groq")).toBeUndefined()
    await connectedRuntimeServices.groq.connectLlmRuntime()
    await connectedRuntimeServices.ollama.connectLlmRuntime()

    expect(
      LLM_PROVIDERS.map((provider) => findChatEndpoint?.(provider))
    ).toEqual([
      undefined,
      buildLlmChatEndpoint(TEST_LLM_PROVIDER_ACCESSES.ollama),
      undefined,
      {
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: "gsk_synthetic_0123456789",
        replyCeilingField: "max_completion_tokens"
      }
    ])
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

  it("lists delegate_work as the only agent tool Settings lists, apart from the built-in tools", async () => {
    const { factories } = createRecordedFactories()

    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(services.listedAgentTools.map((tool) => tool.name)).toEqual([
      DELEGATE_WORK_TOOL_NAME
    ])
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

    expect(gate.startToolCall(pageCall, false, () => true).status).toBe(
      "allowed"
    )
    expect(gate.startToolCall(searchCall, false, () => true).status).toBe(
      "prompted"
    )
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
    expect(Object.isFrozen(services.llmProviderServices)).toBe(true)
    expect(Object.keys(services.llmProviderServices)).toEqual(LLM_PROVIDERS)
    for (const provider of LLM_PROVIDERS) {
      expect(services.llmProviderServices[provider].llmRuntimeService).toBe(
        acquisitions.llmRuntime[provider].service
      )
      expect(services.llmProviderServices[provider].llmService).toBeInstanceOf(
        LlmService
      )
    }
    expect(services.attachmentFileStore).toBeInstanceOf(AttachmentFileStore)
    expect(services.replyGenerations).toBeInstanceOf(ReplyGenerationRegistry)
    expect(services.activityHub).toBeInstanceOf(ActivityHub)
    expect(services.conversationWakeSettings).toBeInstanceOf(
      ConversationWakeSettings
    )
    expect(services.handleTurnStarted).toEqual(expect.any(Function))
    expect(services.createTurnDelegation).toEqual(expect.any(Function))
    expect(services.handleReplyEnded).toEqual(expect.any(Function))
    expect(services.stopReply).toEqual(expect.any(Function))
    expect(services.stopConversationJobs).toEqual(expect.any(Function))
    expect(services.listWorkingReplies).toEqual(expect.any(Function))
    expect(services.stopDeletedReplies).toEqual(expect.any(Function))
  })

  it("gives a member work through the bundle's delegation hooks: the job's turn is stored and answered by the member, and its result waits while the lead's reply streams", async () => {
    const { services, reporters, delegating, draft } =
      await openDelegatingBundle()
    const conversationId = delegating.turn.conversation.id
    const delegation = services.createTurnDelegation(delegating)

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
    expect(reporters.reportDelegationEvent.mock.calls).toEqual([
      [
        {
          kind: "job-message-sent",
          conversationId,
          jobId: job.id,
          jobNumber: 1,
          agentCode: "researcher",
          isNewJob: true
        }
      ],
      [
        {
          kind: "report-stored",
          conversationId,
          jobId: job.id,
          jobNumber: 1,
          reportKind: "result"
        }
      ],
      [{ kind: "wake-up-skipped", conversationId, reason: "reply-streaming" }]
    ])
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

    expect(model.findLlmContextMeasurement).toHaveBeenCalledWith(
      TURN_MODEL.modelKey,
      []
    )
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

    expect(model.findLlmContextMeasurement).toHaveBeenCalledWith(
      TURN_MODEL.modelKey,
      []
    )
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
    /** A photo the person attached, before its conversation numbers it. */
    const photoAttachment: ConversationAttachmentDraft = Object.freeze({
      kind: "image",
      name: "photo.png",
      sizeBytes: 33,
      mediaType: "image/png",
      width: 64,
      height: 32
    })

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
      [photoAttachment]
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
      { call: { toolName: "read_text_file", arguments: { path: "/notes.md" } } }
    ])
  })

  it("starts each turn with the tool call policy of the configured settings file", async () => {
    const { factories } = createRecordedFactories()
    const settingsFilePath = await writeSettingsFile(
      JSON.stringify({ tools: { approvedFolders: ["/srv/shared/"] } })
    )
    const services = await createSingletonServices(
      { ...TEST_BACKEND_CONFIG, settingsFilePath },
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    createModelSpies(services).generateTitle.mockResolvedValue("Greeting")
    const agent = services.agentRuntimeService.loadChatAgent("caliginia")
    if (agent === undefined) throw new Error("Caliginia is not live")
    const createReply = vi.spyOn(agent, "createReply")

    const { generation } = startHelloTurn(
      services,
      PLAIN_TURN_SETTINGS,
      NO_ATTACHMENTS
    )
    await generation.settled

    const toolCallPolicy = createReply.mock.lastCall?.[0].toolCallPolicy
    expect(toolCallPolicy).toEqual({
      settingsFilePath,
      homeFolderPath: homedir(),
      readApprovedFolders: expect.any(Function)
    })
    await expect(toolCallPolicy?.readApprovedFolders()).resolves.toStrictEqual({
      kind: "listed",
      folderPaths: ["/srv/shared"]
    })
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
      model: LM_STUDIO_QWEN3_8B
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
        acquisitions.llmRuntime.lmStudio.service,
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

  it("builds Armitage, the tool keeper, from its configured prompt", async () => {
    const { factories } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))

    expect(services.agentService.findAgent(ARMITAGE_AGENT_CODE)).toEqual({
      agent: {
        kind: "built-in",
        code: ARMITAGE_AGENT_CODE,
        name: "Armitage",
        bio: "Lys's tool keeper. It finds the tools the other agents need and answers agents, not chats.",
        systemPrompt: TEST_BACKEND_CONFIG.armitageSystemPrompt
      },
      deletedAt: null
    })
  })

  it("has Armitage answer a tool search with its configured prompt and the task over the acquired chat and LLM services", async () => {
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
      acquisitions.llmRuntime.lmStudio.service,
      "handleLlmEngineOperationRequest"
    ).mockImplementation(
      async (operation) => await operation(createConnectedFakeLlmEngine(engine))
    )
    const failure = new Error("model not loaded")
    const completeChatStream = vi
      .spyOn(acquisitions.chat.service, "completeChatStream")
      .mockRejectedValue(failure)
    const reportFailure = vi.fn()

    const generationOptions: MessageGenerationOptions = { temperature: 0.4 }

    const outcome = await services.agentRuntimeService.findTools({
      task: "read a web page",
      searchCallId: SEARCH_CALL_ID,
      tools: [READ_TEXT_FILE_TOOL],
      conversationId: createFixtureUuidV7(1),
      model: LM_STUDIO_QWEN3_8B,
      generationOptions,
      abortSignal: new AbortController().signal,
      reportFailure,
      toolCallPolicy: TOOL_CALL_POLICY
    })

    expect(completeChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "system",
            content: TEST_BACKEND_CONFIG.armitageSystemPrompt
          },
          { role: "user", content: "read a web page" }
        ]
      })
    )
    expect(outcome).toEqual({ status: "failed" })
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it("measures and sends a reply on the provider of the turn's model, never on another provider", async () => {
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
    const operationRequests = LLM_PROVIDERS.map((provider) =>
      vi
        .spyOn(
          acquisitions.llmRuntime[provider].service,
          "handleLlmEngineOperationRequest"
        )
        .mockImplementation(
          async (operation) =>
            await operation(createConnectedFakeLlmEngine(engine))
        )
    )
    const completeChatStream = vi
      .spyOn(acquisitions.chat.service, "completeChatStream")
      .mockRejectedValue(new Error("model not loaded"))

    await services.agentRuntimeService
      .loadChatAgent("caliginia")
      ?.createReply(buildHelloAgentTurn(createFixtureUuidV7(2), GROQ_QWEN3_8B))

    expect(
      operationRequests.map((request) => request.mock.calls.length)
    ).toEqual(LLM_PROVIDERS.map((provider) => (provider === "groq" ? 1 : 0)))
    expect(engine.findLlmContextMeasurement).toHaveBeenCalledWith(
      "qwen/qwen3-8b",
      [TEST_BACKEND_CONFIG.caliginiaSystemPrompt, "Hello"]
    )
    expect(completeChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: GROQ_QWEN3_8B })
    )
  })

  it("gives every live agent the configured request slots and waiting line", async () => {
    const { factories, acquisitions } = createRecordedFactories()
    const services = await createSingletonServices(
      TEST_BACKEND_CONFIG,
      createLogReporters(),
      factories
    )
    onTestFinished(async () => await closeSingletonServices(services))
    updateLlmEngineToFittingFake(acquisitions.llmRuntime.lmStudio.service)
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

  it.each(LLM_PROVIDERS)(
    "serves the LLM service of %s through that provider's runtime operation queue alone",
    async (provider) => {
      const { factories, acquisitions } = createRecordedFactories()
      const refusal = new Error("The LLM runtime is closed.")
      const operationRequests = LLM_PROVIDERS.map((queued) =>
        vi
          .spyOn(
            acquisitions.llmRuntime[queued].service,
            "handleLlmEngineOperationRequest"
          )
          .mockRejectedValue(refusal)
      )
      const services = await createSingletonServices(
        TEST_BACKEND_CONFIG,
        createLogReporters(),
        factories
      )
      onTestFinished(async () => await closeSingletonServices(services))

      await expect(
        services.llmProviderServices[provider].llmService.listLlmModels()
      ).rejects.toBe(refusal)

      expect(
        operationRequests.map((request) => request.mock.calls.length)
      ).toEqual(LLM_PROVIDERS.map((queued) => (queued === provider ? 1 : 0)))
    }
  )

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

  it("releases the earlier providers' runtime services, then the database, when one provider's LLM runtime service cannot be created", async () => {
    const { factories, acquisitions, closeLog } = createRecordedFactories()
    const creationFailure = new Error("LLM runtime service construction failed")
    factories.createLlmRuntimeService.mockImplementation(
      buildLlmRuntimeServiceFactoryFailingFor(
        acquisitions.llmRuntime,
        "ollamaCloud",
        creationFailure
      )
    )

    await expect(
      createSingletonServices(
        TEST_BACKEND_CONFIG,
        createLogReporters(),
        factories
      )
    ).rejects.toBe(creationFailure)

    expect(closeLog).toEqual([
      "llm-runtime:ollama",
      "llm-runtime:lmStudio",
      "database"
    ])
    expect(factories.createLlmRuntimeService).toHaveBeenCalledTimes(3)
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

    expect(closeLog).toEqual([...LLM_RUNTIME_RELEASE_NAMES, "database"])
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
    expect(closeLog).toEqual(LLM_RUNTIME_RELEASE_NAMES)
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
      model: LM_STUDIO_QWEN3_8B
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

  /**
   * Creates a bundle from recorded factories, whose activity hub's disposal
   * the cleanup log records as `activity-hub` before the hub is disposed
   * of.
   *
   * @returns The bundle and the recorded acquisitions and cleanup log.
   * @remarks The bundle takes its hub's disposal method when it creates the
   * hub, so the method is spied on the hub's class before the bundle is
   * created; the spy is restored when the test finishes.
   */
  async function createServicesRecordingHubDisposal() {
    const recorded = createRecordedFactories()
    const dispose = ActivityHub.prototype[Symbol.dispose]
    vi.spyOn(ActivityHub.prototype, Symbol.dispose).mockImplementation(
      function (this: ActivityHub) {
        recorded.closeLog.push("activity-hub")
        dispose.call(this)
      }
    )
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

    expect(closeLog).toEqual(["chat", ...LLM_RUNTIME_RELEASE_NAMES, "database"])
  })

  it("closes the wake settings, then disposes of the activity hub, then ends every running reply generation, before it closes the MCP server registry or releases an acquisition, and leaves the reply generation registry closed", async () => {
    const { services, closeLog } = await createServicesRecordingHubDisposal()
    updateServiceClose(
      services.conversationWakeSettings,
      "wake-settings",
      closeLog
    )
    const closeMcpServerRegistry = vi.spyOn(services.mcpServerRegistry, "close")
    const replyTask = startControlledGeneration(services.replyGenerations)
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

    expect(closedBeforeCancellation).toEqual(["wake-settings", "activity-hub"])
    expect(closedWhileGenerating).toEqual({
      isReplyCancelled: true,
      mcpServerRegistryCloseCount: 0,
      closedServices: ["wake-settings", "activity-hub"]
    })
    expect(closeMcpServerRegistry).toHaveBeenCalledOnce()
    expect(closeLog).toEqual([
      "wake-settings",
      "activity-hub",
      "chat",
      ...LLM_RUNTIME_RELEASE_NAMES,
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

  it("disposes of the activity hub, then closes the email account checker, then the MCP server registry, before every acquisition", async () => {
    const { services, closeLog } = await createServicesRecordingHubDisposal()
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
      ...LLM_RUNTIME_RELEASE_NAMES,
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

    for (const acquisition of [
      acquisitions.chat,
      acquisitions.database,
      ...Object.values(acquisitions.llmRuntime)
    ]) {
      expect(acquisition.closeService).toHaveBeenCalledOnce()
    }
  })

  it("attempts every release and rejects with the failure", async () => {
    const { services, acquisitions, closeLog } = await createRecordedServices()
    const releaseFailure = new Error("runtime release failed")
    acquisitions.llmRuntime.ollama.closeService.mockRejectedValue(
      releaseFailure
    )

    await expect(closeSingletonServices(services)).rejects.toBe(releaseFailure)

    expect(closeLog).toEqual([
      "chat",
      "llm-runtime:groq",
      "llm-runtime:ollamaCloud",
      "llm-runtime:lmStudio",
      "database"
    ])
    await expect(closeSingletonServices(services)).rejects.toBe(releaseFailure)
    expect(acquisitions.llmRuntime.ollama.closeService).toHaveBeenCalledOnce()
  })

  it("keeps the failures of two providers' releases and still releases the rest", async () => {
    const { services, acquisitions, closeLog } = await createRecordedServices()
    const groqFailure = new Error("Groq runtime release failed")
    const lmStudioFailure = new Error("LM Studio runtime release failed")
    acquisitions.llmRuntime.groq.closeService.mockRejectedValue(groqFailure)
    acquisitions.llmRuntime.lmStudio.closeService.mockRejectedValue(
      lmStudioFailure
    )

    const failure = await closeSingletonServices(services).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(SuppressedError)
    expect(failure).toMatchObject({
      error: lmStudioFailure,
      suppressed: groqFailure
    })
    expect(closeLog).toEqual([
      "chat",
      "llm-runtime:ollamaCloud",
      "llm-runtime:ollama",
      "database"
    ])
  })
})
