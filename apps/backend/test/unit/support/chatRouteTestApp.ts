import { mcpSettingsSchema } from "@lys/share"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { validatorCompiler } from "fastify-type-provider-zod"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onTestFinished, vi, type Mock, type MockInstance } from "vitest"
import SqliteAgentRecordStore from "../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import type {
  DatabaseFunctionRegistry,
  DatabaseReader,
  DatabaseWriter
} from "../../../src/infrastructure/database/databaseTransactions"
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
import LlmRuntimeService from "../../../src/modules/llm/llmRuntimeService"
import LlmService from "../../../src/modules/llm/llmService"
import McpServerRegistry, {
  type BuiltInMcpServer
} from "../../../src/modules/mcp/mcpServerRegistry"
import { openMcpServer } from "../../../src/modules/mcp/mcpServerOpening"
import type { McpSettingsRead } from "../../../src/infrastructure/settings/mcpSettingsFile"
import type { BuiltInToolEntry } from "../../../src/modules/tool/builtIn/builtInTool"
import ToolApprovalService, {
  type ReadJustRunToolNames
} from "../../../src/modules/toolApproval/toolApprovalService"
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
import SqliteToolSearchCallRecordWriter from "../../../src/infrastructure/database/conversations/sqliteToolSearchCallRecordWriter"

/** Published path of the chat route. */
const CHAT_PATH = "/api/v1/chat"

/** Longest a test MCP server may take to open. */
const MCP_TEST_OPENING_TIMEOUT_MILLISECONDS = 10_000

/**
 * System prompts of the built-in agents in the chat route test app; each
 * differs from the other and from every stored prompt, so a case can tell
 * which one the model received.
 */
export const TEST_BUILT_IN_AGENT_PROMPTS = Object.freeze({
  caliginia: "You are the test Caliginia.",
  lysiptera: "You are the test Lysiptera.",
  armitage: "You are the test Armitage."
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
     * Registry a case passes to the chat route; disposed when the test
     * finishes, before the conversation database closes.
     */
    generations: ReplyGenerationRegistry
    /**
     * Settings reader of `app.mcpServerRegistry`; reads no server until a
     * case configures it and applies the settings.
     */
    readMcpSettings: Mock<() => Promise<McpSettingsRead>>
    /**
     * Read access to the in-memory conversation database the services store
     * on, for records no service reads, such as the tool call decisions.
     */
    database: DatabaseReader
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

/** The chat route test app's services and the spies inside them. */
type SpiedChatRouteTestServices = Readonly<{
  /** Services the application registers. */
  services: ChatRouteTestServices
  /** Spies inside the services, which a case configures or inspects. */
  spies: ChatRouteTestSpies
  /** Read access to the conversation database the services store on. */
  database: DatabaseReader
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
 * @param builtInServers - Servers Lys ships that its MCP server registry
 * holds; none by default.
 * @returns The application, the destination of its log, and the spies.
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
 * a case applies settings, and it is closed when the test finishes. When the
 * test finishes, the generation
 * registry is disposed first, so every generation it holds has stored its
 * final state before the in-memory conversation database is closed; the
 * directory is removed last.
 */
export async function createChatRouteTestApp(
  builtInServers: readonly BuiltInMcpServer[] = []
): Promise<ChatRouteTestApp> {
  const attachmentsDirectoryPath = mkdtempSync(
    join(tmpdir(), "lys-chat-route-attachments-")
  )
  onTestFinished(() => {
    rmSync(attachmentsDirectoryPath, { recursive: true, force: true })
  })
  const testFastify = await createChatSseTestApp()
  const { services, spies, database } = await createChatRouteTestServices(
    attachmentsDirectoryPath,
    builtInServers
  )
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  testFastify.app.setValidatorCompiler(validatorCompiler)
  registerChatRouteTestServices(testFastify.app, services)
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
 * Creates the services of {@link createChatRouteTestApp} over one in-memory
 * conversation database, with every call the chat route can reach replaced
 * by a spy.
 *
 * @param attachmentsDirectoryPath - Directory the attachment file store
 * keeps its files under; the caller owns it.
 * @param builtInServers - Servers Lys ships that the MCP server registry
 * holds.
 * @returns The services, their spies, and read access to their database.
 * @throws If the LLM runtime service cannot connect.
 * @remarks When the test finishes, the MCP server registry closes first,
 * then the LLM runtime service is disposed, and the database closes last.
 */
async function createChatRouteTestServices(
  attachmentsDirectoryPath: string,
  builtInServers: readonly BuiltInMcpServer[]
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
  const mcp = createTestMcpServerRegistry(builtInServers)
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
    requestLimits: TEST_AGENT_REQUEST_LIMITS,
    toolSearchCallRecords: new SqliteToolSearchCallRecordWriter(
      conversation.database
    ),
    readLysEmailAddress: () => null
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
 * @param builtInServers - Servers Lys ships that the registry holds; none
 * by default.
 * @returns The registry and its settings reader.
 * @remarks The registry saves its process groups to a folder the test
 * owns, and it is closed when the test finishes.
 */
export function createTestMcpServerRegistry(
  builtInServers: readonly BuiltInMcpServer[] = []
): TestMcpServerRegistry {
  const emptyMcpSettings = mcpSettingsSchema.parse({})
  const readMcpSettings = vi.fn<() => Promise<McpSettingsRead>>(() =>
    Promise.resolve(
      Object.freeze({ status: "read", settings: emptyMcpSettings })
    )
  )
  const { processGroups } = createOwnedMcpServerProcessGroups()
  const mcpServerRegistry = new McpServerRegistry({
    readSettings: readMcpSettings,
    builtInServers,
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
