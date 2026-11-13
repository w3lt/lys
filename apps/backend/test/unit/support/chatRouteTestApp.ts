import { mcpSettingsSchema } from "@lys/share"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { validatorCompiler } from "fastify-type-provider-zod"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onTestFinished, vi, type Mock, type MockInstance } from "vitest"
import SqliteAgentRecordStore from "../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import SqliteJobActivityReader from "../../../src/infrastructure/database/delegation/sqliteJobActivityReader"
import SqliteJobReader from "../../../src/infrastructure/database/delegation/sqliteJobReader"
import SqliteJobReportWriter from "../../../src/infrastructure/database/delegation/sqliteJobReportWriter"
import type {
  DatabaseFunctionRegistry,
  DatabaseReader,
  DatabaseWriter
} from "../../../src/infrastructure/database/databaseTransactions"
import type SqliteDatabase from "../../../src/infrastructure/database/sqliteDatabase"
import ActivityHub from "../../../src/modules/activity/activityHub"
import AgentRuntimeService, {
  buildConversationTitleLookup
} from "../../../src/modules/agent/agentRuntimeService"
import AgentService from "../../../src/modules/agent/agentService"
import AttachmentFileStore from "../../../src/modules/attachment/attachmentFileStore"
import { buildBuiltInAgents } from "../../../src/modules/agent/builtInAgents"
import ChatService from "../../../src/modules/chat/chatService"
import LlmReplyContextMeter from "../../../src/modules/chat/llmReplyContextMeter"
import OpenAiReplyModel from "../../../src/modules/chat/openAiReplyModel"
import type { ConversationReader } from "../../../src/modules/conversation/capabilities"
import type StoredConversationTurns from "../../../src/modules/conversation/turns"
import ReplyGenerationRegistry from "../../../src/modules/chat/replyGenerationRegistry"
import {
  createModelCapabilitiesLookup,
  type FindModelCapabilities
} from "../../../src/modules/chat/routes/modelCapabilities"
import {
  startTurn,
  type TurnStartDependencies
} from "../../../src/modules/chat/turnStart"
import ConversationWakeSettings from "../../../src/modules/delegation/conversationWakeSettings"
import { createDelegationRuntime } from "../../../src/modules/delegation/delegationRuntime"
import { handleDelegationEvent } from "../../../src/modules/delegation/delegationEventLog"
import ReplyStopRequests from "../../../src/modules/delegation/replyStopRequests"
import LlmRuntimeService from "../../../src/modules/llm/llmRuntimeService"
import LlmService from "../../../src/modules/llm/llmService"
import McpServerRegistry from "../../../src/modules/mcp/mcpServerRegistry"
import { openMcpServer } from "../../../src/modules/mcp/mcpServerOpening"
import type { McpSettingsRead } from "../../../src/infrastructure/settings/mcpSettingsFile"
import type { BuiltInToolEntry } from "../../../src/modules/tool/builtIn/builtInTool"
import ToolApprovalService, {
  type ReadJustRunToolNames
} from "../../../src/modules/toolApproval/toolApprovalService"
import { TEST_BACKEND_CONFIG } from "./backendConfig"
import { createChatSseTestApp } from "./chatSseRoute"
import {
  createAcquiredFakeLlmRuntime,
  createFakeLlmRuntime
} from "./fakeLlmRuntime"
import { DEFAULT_LM_STUDIO_ACCESS } from "./llmFixtures"
import { openConversationTestServices } from "./conversationDatabase"
import type { TestFastify } from "./fastifyTestApp"
import {
  runLookUpWordWithSource,
  CHECK_SPELLING_TOOL,
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "./scriptedBuiltInTool"
import { ROOMY_CONTEXT_LENGTH } from "./replyContextMeterFakes"
import { ScriptedBuiltInToolProvider } from "./scriptedBuiltInToolProvider"
import { createOwnedMcpServerProcessGroups } from "./mcpServerProcessGroups"

/** Published path of the chat route. */
const CHAT_PATH = "/api/v1/chat"

/** Longest a test MCP server may take to open. */
const MCP_TEST_OPENING_TIMEOUT_MILLISECONDS = 10_000

/**
 * Most title requests the chat route test app's turn start makes for one
 * turn.
 */
const TEST_TITLE_GENERATION_MAX_ATTEMPTS = 2

/**
 * System prompts of the built-in agents in the chat route test app; each
 * differs from the other and from every stored prompt, so a case can tell
 * which one the model received.
 */
export const TEST_BUILT_IN_AGENT_PROMPTS = Object.freeze({
  caliginia: "You are the test Caliginia.",
  lysiptera: "You are the test Lysiptera."
})

/**
 * Request limits of every live agent in the chat route test app: two
 * replies of one agent run at once and one more may wait, so a case reaches
 * the waiting line and the refusal with few conversations.
 */
export const TEST_AGENT_REQUEST_LIMITS = Object.freeze({
  slotCount: 2,
  waitingLimit: 1
})

/** Test application decorated with the services the chat route borrows. */
export type ChatRouteTestApp = TestFastify &
  Readonly<{
    /**
     * Turn creation of `app.conversationTurns`; throws until a case configures
     * it.
     */
    createConversationTurn: MockInstance<
      StoredConversationTurns["createConversationTurn"]
    >
    /** Chat completion of `app.chatService`; rejects if it is ever called. */
    completeChatStream: MockInstance<ChatService["completeChatStream"]>
    /** Title generation of `app.chatService`; rejects if it is ever called. */
    generateTitle: MockInstance<ChatService["generateTitle"]>
    /**
     * Context measurement of `app.llmService`, which every agent's meter and
     * the title task's loaded check use; by default the model is loaded with
     * a window larger than any test context, and each text is one token.
     */
    findLlmContextMeasurement: MockInstance<
      LlmService["findLlmContextMeasurement"]
    >
    /**
     * Downloaded models of `app.llmService`, which {@link findModelCapabilities}
     * reads for a model's capabilities; lists no model until a case configures
     * it, so every model sees no image and is offered no attachment reader.
     */
    listDownloadedLlmModels: MockInstance<LlmService["listDownloadedLlmModels"]>
    /**
     * Capability lookup over {@link listDownloadedLlmModels}, which a case
     * passes to the chat route; it remembers each listed model for the test.
     */
    findModelCapabilities: FindModelCapabilities
    /**
     * Reader of the saved Just run choices behind `app.toolApprovalService`;
     * rejects until a case configures it.
     */
    readJustRunToolNames: MockInstance<ReadJustRunToolNames>
    /**
     * Directory `app.attachmentFileStore` keeps attachment files under,
     * created for the test and removed when it finishes.
     */
    attachmentsDirectoryPath: string
    /**
     * Registry of `app.replyGenerations`, with which `app.startTurn`
     * registers every generation it starts; disposed when the test
     * finishes, before the conversation database closes.
     */
    generations: ReplyGenerationRegistry
    /**
     * Settings reader of `app.mcpServerRegistry`; reads no server until a
     * case configures it and applies the settings.
     */
    readMcpSettings: Mock<() => Promise<McpSettingsRead>>
    /**
     * Database the decorated conversation services and agent records store
     * on, where a case stores rows no request stores, such as a job.
     */
    database: SqliteDatabase
  }>

/**
 * Services that {@link createChatRouteTestApp} registers with its
 * application, under the names the routes reach them by.
 */
type ChatRouteTestServices = Readonly<
  Pick<
    FastifyInstance,
    | "conversationTurns"
    | "replyParts"
    | "conversationHistoryReader"
    | "conversationHistoryEditor"
    | "chatService"
    | "llmService"
    | "llmRuntimeService"
    | "agentService"
    | "agentRuntimeService"
    | "toolApprovalService"
    | "attachmentFileStore"
    | "mcpServerRegistry"
    | "builtInTools"
  >
>

/** Spies of {@link ChatRouteTestApp} that its services call. */
type ChatRouteTestSpies = Pick<
  ChatRouteTestApp,
  | "createConversationTurn"
  | "completeChatStream"
  | "generateTitle"
  | "findLlmContextMeasurement"
  | "listDownloadedLlmModels"
  | "readJustRunToolNames"
  | "readMcpSettings"
>

/**
 * The chat route test app's services, the spies inside them, and the
 * database they store on.
 */
type SpiedChatRouteTestServices = Readonly<{
  /** Services the application registers. */
  services: ChatRouteTestServices
  /** Spies inside the services, which a case configures or inspects. */
  spies: ChatRouteTestSpies
  /** Database the conversation services and agent records store on. */
  database: SqliteDatabase
}>

/** A chat service and the spies that replace its model calls. */
type SpiedChatService = Readonly<{
  /** The service; its endpoint is an LM Studio URL that no case reaches. */
  chatService: ChatService
}> &
  Pick<ChatRouteTestApp, "completeChatStream" | "generateTitle">

/** An LLM service and the spies that replace its measurement and inventory. */
type SpiedLlmService = Readonly<{
  /** The service; its engine operation queue rejects every operation. */
  llmService: LlmService
}> &
  Pick<
    ChatRouteTestApp,
    "findLlmContextMeasurement" | "listDownloadedLlmModels"
  >

/** A real MCP server registry and the spy it reads its settings through. */
export type TestMcpServerRegistry = Readonly<{
  /** The registry; it holds no server until a case applies settings. */
  mcpServerRegistry: McpServerRegistry
  /**
   * Its settings reader; it reads the settings group with no server until
   * a case configures it.
   */
  readMcpSettings: Mock<() => Promise<McpSettingsRead>>
}>

/** A case's application, as the case updates and lists its MCP servers. */
type McpServerRegistryTestApp = Readonly<{
  /** The registry, through its update and its list of servers. */
  mcpServerRegistry: Pick<McpServerRegistry, "updateServers" | "listServers">
}>

/**
 * The parts of a case's application that a case updates its MCP servers
 * through: the spy the registry reads its settings through, and the
 * registry's update and list.
 */
export type McpServerUpdateTestApp = Readonly<{
  /** Spy the registry reads its settings through. */
  readMcpSettings: TestMcpServerRegistry["readMcpSettings"]
  /** Application whose registry the case updates and lists. */
  app: McpServerRegistryTestApp
}>

/**
 * What a case's agent services use of its conversation services: the
 * database their records are kept on, and the history the agents title
 * conversations from.
 */
export type AgentConversationTestServices = Readonly<{
  /** Database the agent record store keeps its records on. */
  database: DatabaseReader & DatabaseWriter & DatabaseFunctionRegistry
  /** History the agents read the titles of conversations from. */
  history: ConversationReader
}>

/**
 * Creates an application with SSE and schema validation whose conversation
 * turns and chat service are real instances with every call the chat route
 * can reach replaced by a spy.
 *
 * @returns The application, the destination of its log, the spies, and the
 * database its services store on.
 * @throws If the SSE plugin cannot be registered.
 * @remarks The chat route is not registered; each case calls the registrar
 * under test. Unconfigured turn creation throws and both chat-service calls
 * reject with `Unexpected chat route call: <name>`, so a case that reaches
 * persistence or the model without arranging it fails. No database row is
 * written and no HTTP request leaves the process. The decorated reply-part
 * persistence is real and stores on the same in-memory database. The
 * decorated agent service
 * keeps its records on the same in-memory database and builds the built-in
 * agents with {@link TEST_BUILT_IN_AGENT_PROMPTS}; the decorated agent
 * runtime service keeps the live agents over it, each with
 * {@link TEST_AGENT_REQUEST_LIMITS}, and titles their requests'
 * conversations from the same database; every agent's model calls
 * go through the `completeChatStream` spy, and every measurement, by their
 * meters and by the title task, through the `findLlmContextMeasurement` spy
 * of the decorated LLM service, and every inventory read through its
 * `listDownloadedLlmModels` spy; its queue rejects anything else. The
 * decorated history reader and editor read and edit the same database, so a
 * case can delete a conversation while a request is in flight. The backend
 * tools are
 * the scripted `look_up_word` tool, always ready, which numbers the
 * dictionary page of each word it looks up as a source, and
 * `check_spelling`, whose provider is never ready (`api-key-missing`). The
 * decorated tool approval service reads the saved Just run choices through
 * the `readJustRunToolNames` spy. The decorated attachment file store is
 * real, over a directory created for the test. The decorated LLM runtime
 * service is connected to {@link DEFAULT_LM_STUDIO_ACCESS} over a runtime
 * double that no case reaches, so the capability lookups remember models
 * for that provider. The decorated MCP server registry is real, reads its
 * settings through the `readMcpSettings` spy, which reads no server, opens
 * servers with a 10-second limit, and logs nothing; it holds no server until
 * a case applies settings, and it is closed when the test finishes. The
 * decorated turn start is the real one, as {@link registerTestTurnStart}
 * binds it to the decorated services and to the decorated reply generation
 * registry, which is the returned one. The decorated delegation hooks are
 * the real ones, as {@link registerTestTurnDelegations} builds them over
 * the decorated services and the same database. When the
 * test finishes, the activity hub of the delegation hooks is closed and the
 * generation registry is disposed first, so every generation it holds has
 * stored its final state before the in-memory conversation database is
 * closed; the directory is removed last.
 */
export async function createChatRouteTestApp(): Promise<ChatRouteTestApp> {
  const attachmentsDirectoryPath = mkdtempSync(
    join(tmpdir(), "lys-chat-route-attachments-")
  )
  onTestFinished(() => {
    rmSync(attachmentsDirectoryPath, { recursive: true, force: true })
  })
  const testFastify = await createChatSseTestApp()
  const { services, spies, database } = await createChatRouteTestServices(
    attachmentsDirectoryPath
  )
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  testFastify.app.setValidatorCompiler(validatorCompiler)
  registerChatRouteTestServices(testFastify.app, services)
  registerTestTurnStart(testFastify.app, generations)
  registerTestTurnDelegations(testFastify.app, database)
  return Object.freeze({
    ...testFastify,
    ...spies,
    findModelCapabilities: createModelCapabilitiesLookup(
      () => services.llmService.listDownloadedLlmModels(),
      () => services.llmRuntimeService.connectedLlmProviderAccess
    ),
    attachmentsDirectoryPath,
    generations,
    database
  })
}

/**
 * Registers a reply generation registry and the turn start bound to it with
 * the chat route test app, as the backend's composition root binds its own.
 *
 * @param app - Application with the conversation services, the chat and LLM
 * services, the tool approval service, and the attachment file store
 * registered; the turn start borrows them for the test.
 * @param generations - Registry the turn start registers every generation
 * with; the caller disposes it.
 * @throws If the application already has a reply generation registry or a
 * turn start.
 * @remarks Title requests and loaded checks go through `app.chatService` and
 * `app.llmService` when they run, so a case's spies on them apply. A turn
 * gets at most {@link TEST_TITLE_GENERATION_MAX_ATTEMPTS} title requests.
 */
function registerTestTurnStart(
  app: FastifyInstance,
  generations: ReplyGenerationRegistry
): void {
  const turns = app.conversationTurns
  const dependencies: TurnStartDependencies = {
    generations,
    turns,
    replyParts: app.replyParts,
    titleWriter: turns,
    findConversation: (conversationId) =>
      app.conversationHistoryReader.getConversation(conversationId),
    attachmentFiles: app.attachmentFileStore,
    generateTitle: (options) => app.chatService.generateTitle(options),
    findLoadedContextLength: async (model) =>
      (await app.llmService.findLlmContextMeasurement(model, []))
        ?.contextLength,
    titleGenerationMaxAttempts: TEST_TITLE_GENERATION_MAX_ATTEMPTS,
    toolApprovals: app.toolApprovalService
  }
  app.decorate("replyGenerations", generations)
  app.decorate("startTurn", (options) => startTurn(dependencies, options))
}

/**
 * Registers the delegation hooks with the chat route test app, over a
 * delegation runtime built as the backend's composition root builds its own.
 *
 * @param app - Application with the agent services, the conversation
 * services, the turn start, and the reply generation registry registered;
 * the runtime borrows them for the test.
 * @param database - Database the job records read and write; the caller
 * closes it.
 * @throws If the application already has delegation hooks.
 * @remarks The runtime's job records are the Sqlite ones over the database,
 * and it stores job turns through `app.conversationTurns`, whose turn
 * creation throws until a case configures it. Its hub is a real activity
 * hub of its own, closed when the test finishes, before the generation
 * registry is disposed. It remembers wake settings and stop requests in
 * instances of its own, allows the job messages of
 * {@link TEST_BACKEND_CONFIG}, and logs its events and the turns it starts
 * with the application's logger.
 */
function registerTestTurnDelegations(
  app: FastifyInstance,
  database: SqliteDatabase
): void {
  const activityHub = new ActivityHub()
  onTestFinished(() => {
    activityHub.close()
  })
  const wakeSettings = new ConversationWakeSettings()
  const stopRequests = new ReplyStopRequests()
  const jobs = new SqliteJobReader(database)
  const jobActivity = new SqliteJobActivityReader(database)
  const reports = new SqliteJobReportWriter(database)
  const runtime = createDelegationRuntime({
    findAgent: (code) => app.agentService.findAgent(code),
    loadChatAgent: (code) => app.agentRuntimeService.loadChatAgent(code),
    findConversationAgentCode: (conversationId) =>
      app.conversationHistoryReader.getConversationMetadata(conversationId)
        ?.agentCode,
    jobs,
    jobActivity,
    reports,
    turns: app.conversationTurns,
    startTurn: app.startTurn,
    generations: app.replyGenerations,
    hub: activityHub,
    wakeSettings,
    stopRequests,
    agentJobMessageLimit: TEST_BACKEND_CONFIG.agentJobMessageLimit,
    reportEvent: (event) => {
      handleDelegationEvent(app.log, event)
    },
    logger: app.log
  })
  app.decorate("turnDelegations", runtime.hooks)
}

/**
 * Creates the services of {@link createChatRouteTestApp} over one in-memory
 * conversation database, with every call the chat route can reach replaced
 * by a spy.
 *
 * @param attachmentsDirectoryPath - Directory the attachment file store
 * keeps its files under; the caller owns it.
 * @returns The services, their spies, and the database they store on.
 * @throws If the LLM runtime service cannot connect.
 * @remarks When the test finishes, the MCP server registry closes first,
 * then the LLM runtime service is disposed, and the database closes last.
 */
async function createChatRouteTestServices(
  attachmentsDirectoryPath: string
): Promise<SpiedChatRouteTestServices> {
  const conversation = openConversationTestServices()
  const createConversationTurn = vi
    .spyOn(conversation.turns, "createConversationTurn")
    .mockImplementation(() => handleUnexpectedCall("createConversationTurn"))
  const chat = createSpiedChatService()
  const llm = createSpiedLlmService()
  const llmRuntimeService = await openTestLlmRuntimeService()
  const agents = createTestAgentServices(
    conversation,
    chat.chatService,
    llm.llmService
  )
  const readJustRunToolNames = vi.fn<ReadJustRunToolNames>(() =>
    Promise.reject(createUnexpectedCallError("readJustRunToolNames"))
  )
  const mcp = createTestMcpServerRegistry()
  return Object.freeze({
    services: Object.freeze({
      conversationTurns: conversation.turns,
      replyParts: conversation.replyParts,
      conversationHistoryReader: conversation.history,
      conversationHistoryEditor: conversation.editor,
      chatService: chat.chatService,
      llmService: llm.llmService,
      llmRuntimeService,
      ...agents,
      toolApprovalService: new ToolApprovalService(readJustRunToolNames),
      attachmentFileStore: new AttachmentFileStore(attachmentsDirectoryPath),
      mcpServerRegistry: mcp.mcpServerRegistry,
      builtInTools: buildScriptedBuiltInTools(
        new ScriptedBuiltInTool(runLookUpWordWithSource)
      )
    }),
    spies: Object.freeze({
      createConversationTurn,
      completeChatStream: chat.completeChatStream,
      generateTitle: chat.generateTitle,
      findLlmContextMeasurement: llm.findLlmContextMeasurement,
      listDownloadedLlmModels: llm.listDownloadedLlmModels,
      readJustRunToolNames,
      readMcpSettings: mcp.readMcpSettings
    }),
    database: conversation.database
  })
}

/**
 * Creates a chat service whose completion and title calls are spies.
 *
 * @returns The service and its spies, which reject with
 * `Unexpected chat route call: <name>` until a case configures them.
 */
function createSpiedChatService(): SpiedChatService {
  const chatService = new ChatService({
    findChatEndpoint: () => ({
      baseUrl: "http://lmstudio.test/v1",
      apiKey: undefined,
      replyCeilingField: "max_completion_tokens"
    }),
    titleGenerationPrompt: "Summarize the message as a short title.",
    generatedTitleMaxLength: 50
  })
  const completeChatStream = vi
    .spyOn(chatService, "completeChatStream")
    .mockImplementation(() =>
      Promise.reject(createUnexpectedCallError("completeChatStream"))
    )
  const generateTitle = vi
    .spyOn(chatService, "generateTitle")
    .mockImplementation(() =>
      Promise.reject(createUnexpectedCallError("generateTitle"))
    )
  return Object.freeze({ chatService, completeChatStream, generateTitle })
}

/**
 * Creates an LLM service whose context measurement and model inventory are
 * spies.
 *
 * @returns The service and its spies. By default the measurement answers
 * that the model is loaded with a window larger than any test context and
 * that each text is one token, and the inventory lists no model.
 */
function createSpiedLlmService(): SpiedLlmService {
  const llmService = new LlmService({
    llmEngineOperationQueue: Object.freeze({
      handleLlmEngineOperationRequest: () =>
        Promise.reject(createUnexpectedCallError("LLM engine operation"))
    })
  })
  const findLlmContextMeasurement = vi
    .spyOn(llmService, "findLlmContextMeasurement")
    .mockImplementation((_model, texts) =>
      Promise.resolve(
        Object.freeze({
          contextLength: ROOMY_CONTEXT_LENGTH,
          textTokenCounts: Object.freeze(texts.map(() => 1))
        })
      )
    )
  const listDownloadedLlmModels = vi
    .spyOn(llmService, "listDownloadedLlmModels")
    .mockResolvedValue([])
  return Object.freeze({
    llmService,
    findLlmContextMeasurement,
    listDownloadedLlmModels
  })
}

/**
 * Opens an LLM runtime service connected to {@link DEFAULT_LM_STUDIO_ACCESS}
 * over a runtime double that no case reaches.
 *
 * @returns The connected service, disposed when the test finishes.
 * @throws If the service cannot connect, as
 * {@link LlmRuntimeService.connectLlmRuntime} documents.
 */
async function openTestLlmRuntimeService(): Promise<LlmRuntimeService> {
  const llmRuntimeService = new LlmRuntimeService({
    reportLlmRuntimeAcquisitionFailure: vi.fn(),
    reportLlmRuntimeAvailabilityCheckFailure: vi.fn(),
    findLlmProviderAccess: () => Promise.resolve(DEFAULT_LM_STUDIO_ACCESS),
    acquireLlmRuntime: () =>
      Promise.resolve(createAcquiredFakeLlmRuntime(createFakeLlmRuntime()))
  })
  await llmRuntimeService.connectLlmRuntime()
  onTestFinished(async () => await llmRuntimeService[Symbol.asyncDispose]())
  return llmRuntimeService
}

/**
 * Creates the agent service, which keeps its records on the test's
 * database and builds the built-in agents with
 * {@link TEST_BUILT_IN_AGENT_PROMPTS}, and the agent runtime service over it,
 * each live agent with {@link TEST_AGENT_REQUEST_LIMITS}.
 *
 * @param conversation - The test's database and the history the live
 * agents title their requests' conversations from.
 * @param chatService - Chat stream every agent's model calls go through.
 * @param llmService - Context measurement every agent's meter measures
 * through.
 * @returns The two services.
 */
function createTestAgentServices(
  conversation: AgentConversationTestServices,
  chatService: Pick<ChatService, "completeChatStream">,
  llmService: Pick<LlmService, "findLlmContextMeasurement">
): Pick<ChatRouteTestServices, "agentService" | "agentRuntimeService"> {
  const agentService = new AgentService({
    recordStore: SqliteAgentRecordStore.create(conversation.database),
    builtInAgents: buildBuiltInAgents(TEST_BUILT_IN_AGENT_PROMPTS)
  })
  const agentRuntimeService = new AgentRuntimeService({
    agents: agentService,
    replyModel: new OpenAiReplyModel((options) =>
      chatService.completeChatStream(options)
    ),
    replyContextMeter: new LlmReplyContextMeter((model, texts) =>
      llmService.findLlmContextMeasurement(model, texts)
    ),
    findConversationTitle: (conversationId) =>
      buildConversationTitleLookup(
        conversation.history.getConversation(conversationId)
      ),
    requestLimits: TEST_AGENT_REQUEST_LIMITS
  })
  return Object.freeze({ agentService, agentRuntimeService })
}

/**
 * Registers the services of {@link createChatRouteTestApp} with its
 * application, so the routes reach them as `app.<service>`.
 *
 * @param app - The test application.
 * @param services - Services the application borrows until the test
 * finishes.
 */
function registerChatRouteTestServices(
  app: FastifyInstance,
  services: ChatRouteTestServices
): void {
  app.decorate("conversationTurns", services.conversationTurns)
  app.decorate("replyParts", services.replyParts)
  app.decorate("conversationHistoryReader", services.conversationHistoryReader)
  app.decorate("conversationHistoryEditor", services.conversationHistoryEditor)
  app.decorate("chatService", services.chatService)
  app.decorate("llmService", services.llmService)
  app.decorate("llmRuntimeService", services.llmRuntimeService)
  app.decorate("agentService", services.agentService)
  app.decorate("agentRuntimeService", services.agentRuntimeService)
  app.decorate("toolApprovalService", services.toolApprovalService)
  app.decorate("attachmentFileStore", services.attachmentFileStore)
  app.decorate("mcpServerRegistry", services.mcpServerRegistry)
  app.decorate("builtInTools", services.builtInTools)
}

/**
 * Creates a real MCP server registry for a chat route test app, which reads
 * its settings through a spy, opens servers with a 10-second limit, and
 * logs nothing.
 *
 * @returns The registry and its settings reader.
 * @remarks The registry saves its process groups to a folder the test
 * owns, and it is closed when the test finishes.
 */
export function createTestMcpServerRegistry(): TestMcpServerRegistry {
  const emptyMcpSettings = mcpSettingsSchema.parse({})
  const readMcpSettings = vi.fn<() => Promise<McpSettingsRead>>(() =>
    Promise.resolve(
      Object.freeze({ status: "read", settings: emptyMcpSettings })
    )
  )
  const { processGroups } = createOwnedMcpServerProcessGroups()
  const mcpServerRegistry = new McpServerRegistry({
    readSettings: readMcpSettings,
    builtInServers: [],
    openServer: (settings, context) =>
      openMcpServer(settings, context, MCP_TEST_OPENING_TIMEOUT_MILLISECONDS),
    workingDirectory: process.cwd(),
    processGroups,
    reportEvent: () => undefined
  })
  onTestFinished(async () => {
    await mcpServerRegistry.close()
  })
  return Object.freeze({ mcpServerRegistry, readMcpSettings })
}

/**
 * Builds the backend tools of a chat route test app: `look_up_word`, always
 * ready, and `check_spelling`, whose provider is never ready
 * (`api-key-missing`).
 *
 * @param lookUpWordTool - Tool that runs each `look_up_word` call.
 * @returns The two tools, `look_up_word` first.
 */
export function buildScriptedBuiltInTools(
  lookUpWordTool: ScriptedBuiltInTool
): readonly BuiltInToolEntry[] {
  return Object.freeze([
    Object.freeze({
      definition: LOOK_UP_WORD_TOOL,
      provider: new ScriptedBuiltInToolProvider({
        status: "ready",
        tool: lookUpWordTool
      })
    }),
    Object.freeze({
      definition: CHECK_SPELLING_TOOL,
      provider: new ScriptedBuiltInToolProvider({
        status: "unavailable",
        reason: "api-key-missing"
      })
    })
  ])
}

/**
 * Sends one chat request accepting an event stream.
 *
 * @param app - Application with the chat route registered.
 * @param payload - Raw request body, serialized as JSON.
 * @returns The completed response.
 */
export async function sendChatRequest(
  app: FastifyInstance,
  payload: unknown
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: "POST",
    url: CHAT_PATH,
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json"
    },
    payload: JSON.stringify(payload)
  })
}

/**
 * Fails a chat-route dependency call that the current case did not arrange.
 *
 * @param operationName - Dependency operation that was called.
 * @throws Always.
 */
function handleUnexpectedCall(operationName: string): never {
  throw createUnexpectedCallError(operationName)
}

/**
 * Creates the failure for a chat-route dependency call that the current case
 * did not arrange.
 *
 * @param operationName - Dependency operation that was called.
 * @returns An error with the message `Unexpected chat route call: <name>`.
 */
function createUnexpectedCallError(operationName: string): Error {
  return new Error(`Unexpected chat route call: ${operationName}`)
}
