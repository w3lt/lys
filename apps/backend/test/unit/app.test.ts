import {
  deleteConversationApi,
  stopChatReplyApi,
  stopConversationJobsApi
} from "@lys/protocol"
import {
  DELEGATE_WORK_TOOL_NAME,
  type Job,
  type McpServerSettings
} from "@lys/share"
import { once } from "node:events"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { FastifyInstance } from "fastify"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import * as z from "zod"
import { buildApp } from "../../src/app"
import type { BackendConfig } from "../../src/config"
import {
  createBackendLogger,
  registerOutputFailureListeners
} from "../../src/log"
import AgentRuntimeService from "../../src/modules/agent/agentRuntimeService"
import AgentService from "../../src/modules/agent/agentService"
import AttachmentFileStore from "../../src/modules/attachment/attachmentFileStore"
import type { CompleteChatOptions } from "../../src/modules/chat/chatService"
import type { ReplyTarget } from "../../src/modules/chat/replyGenerationRegistry"
import StoredConversationHistoryEditor from "../../src/modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../../src/modules/conversation/historyReader"
import StoredReplyParts from "../../src/modules/conversation/replyParts"
import StoredConversationTurns from "../../src/modules/conversation/turns"
import { ChatCompletionCancelledError } from "../../src/utils/errors"
import { TEST_BACKEND_CONFIG } from "./support/backendConfig"
import { sendChatRequest } from "./support/chatRouteTestApp"
import { parseSseEvents } from "./support/chatSseRoute"
import ControlledReplyTask from "./support/controlledReplyTask"
import { openSqliteConversationRecords } from "./support/conversationDatabase"
import {
  createFixtureUuidV7,
  createNewConversationTarget,
  createTurnUserMessage
} from "./support/conversationFixtures"
import {
  createJobMessageDraft,
  createPersonTurn,
  findFirstJob,
  FIRST_MEMBER_DEFINITION,
  MOTHS_REQUEST,
  waitForFirstJobReplyEnd
} from "./support/delegationTestServices"
import { CapturedLogDestination } from "./support/fastifyTestApp"
import { buildFakeStdioServerSettings } from "./support/mcpTestServers"
import {
  fakeLmStudio,
  type FakeLmStudioOperations
} from "./support/lmStudioSdkFake"
import { createChatCompletionChunk } from "./support/openAiEndpointFake"
import { createFailingOutput, createWorkingOutput } from "./support/testOutputs"

vi.mock("@lmstudio/sdk", () => import("./support/lmStudioSdkFake"))

/**
 * Creates a configuration that satisfies `backendConfigSchema`, with the
 * conversation database and the MCP process groups file in a temporary
 * directory owned by the current test.
 *
 * @returns The test configuration; the directory exists, so a store opened on
 * its database path would create the file, and the MCP process groups file
 * can be saved. The directory is removed when the test finishes.
 */
function createOwnedBackendConfig(): BackendConfig {
  const directory = mkdtempSync(join(tmpdir(), "lys-app-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    ...TEST_BACKEND_CONFIG,
    databaseFilePath: join(directory, "lys_db.sqlite"),
    mcpProcessGroupsFilePath: join(directory, "mcp-process-groups")
  }
}

/**
 * Creates an owned configuration whose settings file names these MCP
 * servers.
 *
 * @param servers - Servers of the `mcp` group, in order.
 * @returns The configuration; its settings file sits beside the database
 * and is removed with it.
 */
function createConfigWithMcpServers(
  servers: readonly McpServerSettings[]
): BackendConfig {
  const config = createOwnedBackendConfig()
  const settingsFilePath = join(
    dirname(config.databaseFilePath),
    "settings.json"
  )
  writeFileSync(settingsFilePath, JSON.stringify({ mcp: { servers } }))
  return { ...config, settingsFilePath }
}

/**
 * Tells whether a process is running.
 *
 * @param processId - Identifier of the process.
 * @returns Whether a signal could reach it.
 * @throws What `process.kill` throws other than for a missing process.
 */
function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false
    throw error
  }
}

/**
 * Reads the process identifier a fake MCP server logged as `pid <id>`.
 *
 * @param log - Log the server's lines reach.
 * @returns The identifier, once the line was logged.
 * @throws While no such line was logged.
 */
function readLoggedProcessId(log: CapturedLogDestination): number {
  const line = log.records
    .map((record) => record["line"])
    .find((value) => typeof value === "string" && value.startsWith("pid "))
  if (typeof line !== "string") throw new Error("No process identifier yet")
  return Number(line.slice("pid ".length))
}

/** Longest a case waits for a fake MCP server to start and connect. */
const MCP_SERVER_WAIT_MILLISECONDS = 10_000

/** Fastify's default request body limit, in bytes, stated in the API reference. */
const REQUEST_BODY_LIMIT = 1_048_576

/**
 * Creates the stream of a model that replies `Hi` and stops.
 *
 * @returns A stream of one chunk.
 */
async function* createHiReplyStream() {
  yield createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
}

/**
 * Creates spies in place of the model calls of an application that no
 * provider is connected to.
 *
 * @param app - Ready application whose LLM service and chat service are
 * spied on.
 * @returns The spies. Every model is loaded with a context of 1,000,000
 * tokens, in which each text counts one token, and every reply is `Hi`.
 */
function createModelSpies(app: FastifyInstance) {
  const findLlmContextMeasurement = vi
    .spyOn(app.llmService, "findLlmContextMeasurement")
    .mockImplementation(async (_model, texts) => ({
      contextLength: 1_000_000,
      textTokenCounts: texts.map(() => 1)
    }))
  const completeChatStream = vi
    .spyOn(app.chatService, "completeChatStream")
    .mockImplementation(async () => createHiReplyStream())
  return { findLlmContextMeasurement, completeChatStream }
}

/**
 * Waits on a chat completion request that the model never answers, as a
 * model still working while the backend closes.
 *
 * @param options - The request; the agent aborts its signal when the
 * reply's generation ends.
 * @returns A promise that never resolves; on a request without a signal it
 * waits for good.
 * @throws {@link ChatCompletionCancelledError} once the signal aborts, as
 * the chat service fails a request the SDK cancelled.
 */
async function waitForCancelledCompletion(
  options: CompleteChatOptions
): Promise<never> {
  const signal = options.signal ?? new AbortController().signal
  if (!signal.aborted) await once(signal, "abort")
  throw new ChatCompletionCancelledError(signal.reason)
}

/**
 * Starts a generation in an application's decorated registry whose reply
 * task stays pending until the case settles it, without a title task.
 *
 * @param app - Ready application whose registry admits the generation.
 * @param target - The reply and the conversation that holds it.
 * @returns The reply task. It begins after the current synchronous step, and
 * it is resolved when the test finishes, so a case that fails early does
 * not leave the application's close waiting.
 */
function startControlledReply(
  app: FastifyInstance,
  target: ReplyTarget
): ControlledReplyTask {
  const replyTask = new ControlledReplyTask()
  app.replyGenerations.startReplyGeneration(target, {
    startReplyTask: (context) => replyTask.start(context),
    startTitleTask: undefined,
    reportTaskFailure: vi.fn()
  })
  onTestFinished(() => {
    replyTask.resolve()
  })
  return replyTask
}

/** A job that works while its backend closes. */
type WorkingJob = Readonly<{
  /** UUIDv7 of the person's main conversation the job was started from. */
  conversationId: string
  /** The job as stored while its reply's model request waits. */
  job: Job
}>

/**
 * Gives a member work through the decorated delegation hooks, and leaves
 * the job's model request waiting.
 *
 * @param app - Ready application that no provider is connected to; its
 * model calls are spied on here.
 * @returns The person's conversation and the job, once the job's reply has
 * sent its model request; the request waits until it is cancelled.
 * @throws If the request is not sent within the wait, or the job is not
 * stored.
 */
async function startWorkingJob(app: FastifyInstance): Promise<WorkingJob> {
  const { completeChatStream } = createModelSpies(app)
  completeChatStream.mockImplementation(waitForCancelledCompletion)
  app.agentService.createAgent(FIRST_MEMBER_DEFINITION)
  const delegating = createPersonTurn(app.conversationTurns)
  const conversationId = delegating.turn.conversation.id
  const draft = createJobMessageDraft(app.replyParts, delegating, MOTHS_REQUEST)
  app.createTurnDelegation(delegating).createJobMessage(draft)
  await vi.waitFor(() => {
    expect(completeChatStream).toHaveBeenCalledOnce()
  })
  const job = findFirstJob(app.conversationHistoryReader, conversationId)
  return { conversationId, job }
}

/**
 * Serializes a new agent definition whose JSON body has an exact size.
 *
 * @param code - Code of the agent.
 * @param byteLength - UTF-8 size of the body, at least that of the definition
 * with an empty system prompt.
 * @returns The JSON body, padded through an ASCII system prompt.
 */
function createAgentBodyOfSize(code: string, byteLength: number): string {
  const definition = { code, name: "Lys", bio: "Bio" }
  const emptyBody = JSON.stringify({ ...definition, systemPrompt: "" })
  return JSON.stringify({
    ...definition,
    systemPrompt: "x".repeat(byteLength - emptyBody.length)
  })
}

describe("buildApp", () => {
  beforeEach(() => {
    fakeLmStudio.reset()
  })

  it("rejects a configuration that fails backendConfigSchema before acquiring any service", async () => {
    // Every interface is refused: the backend does not authenticate
    // non-browser callers, so it must listen on loopback only.
    const config = { ...createOwnedBackendConfig(), backendHost: "0.0.0.0" }
    const constructClient = vi.fn<FakeLmStudioOperations["constructClient"]>()
    fakeLmStudio.operations = { ...fakeLmStudio.operations, constructClient }

    const log = new CapturedLogDestination()

    const build = buildApp({ config, logger: createBackendLogger(log) })

    await expect(build).rejects.toBeInstanceOf(z.ZodError)
    await expect(build).rejects.toMatchObject({
      issues: [{ path: ["backendHost"] }]
    })
    expect(constructClient).not.toHaveBeenCalled()
    expect(existsSync(config.databaseFilePath)).toBe(false)
    expect(log.records).toEqual([])
  })

  it("rejects with the failure of a service that cannot be created, such as a database that cannot be opened", async () => {
    const ownedConfig = createOwnedBackendConfig()
    // SQLite does not create a missing directory, so opening the database
    // fails while the services are registered.
    const config = {
      ...ownedConfig,
      databaseFilePath: join(
        dirname(ownedConfig.databaseFilePath),
        "missing",
        "lys_db.sqlite"
      )
    }

    const build = buildApp({
      config,
      logger: createBackendLogger(new CapturedLogDestination())
    })

    await expect(build).rejects.toThrow("unable to open database file")
  })

  it("decorates the conversation adapters, the agent service, and the attachment file store and serves history and agents from the configured database", async () => {
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(new CapturedLogDestination())
    })
    onTestFinished(async () => await app.close())
    await app.ready()

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations"
    })
    const agentsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/agents"
    })

    expect(app.conversationTurns).toBeInstanceOf(StoredConversationTurns)
    expect(app.conversationHistoryReader).toBeInstanceOf(
      StoredConversationHistoryReader
    )
    expect(app.conversationHistoryEditor).toBeInstanceOf(
      StoredConversationHistoryEditor
    )
    expect(app.agentService).toBeInstanceOf(AgentService)
    expect(app.agentRuntimeService).toBeInstanceOf(AgentRuntimeService)
    expect(app.attachmentFileStore).toBeInstanceOf(AttachmentFileStore)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ storedCount: 0 })
    expect(agentsResponse.statusCode).toBe(200)
    expect(agentsResponse.json()).toEqual({
      builtInAgents: [
        { code: "caliginia", name: "Caliginia", bio: "Lys's dark side." },
        { code: "lysiptera", name: "Lysiptera", bio: "Lys's light side." }
      ],
      agents: [],
      storedCount: 0,
      nextCursor: null
    })
  })

  it("decorates the reply part store over the configured database", async () => {
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(new CapturedLogDestination())
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const turn = app.conversationTurns.createConversationTurn({
      conversation: createNewConversationTarget("caliginia"),
      userMessage: createTurnUserMessage("Hello"),
      model: "qwen/qwen3-8b"
    })

    const part = app.replyParts.createReplyPart(turn.assistantMessage.id, {
      kind: "text",
      round: 0,
      content: "Hi"
    })

    expect(app.replyParts).toBeInstanceOf(StoredReplyParts)
    expect(
      app.conversationHistoryReader.getConversation(turn.conversation.id)
    ).toMatchObject({ messages: [turn.userMessage, { parts: [part] }] })
  })

  it("answers a chat request through the decorated turn start, which stores the reply and the generated title", async () => {
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(new CapturedLogDestination())
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    // No provider is connected: the model calls are answered here instead.
    vi.spyOn(app.llmService, "listDownloadedLlmModels").mockResolvedValue([])
    vi.spyOn(app.llmService, "findLlmContextMeasurement").mockImplementation(
      async (_model, texts) => ({
        contextLength: 1_000_000,
        textTokenCounts: texts.map(() => 1)
      })
    )
    vi.spyOn(app.chatService, "completeChatStream").mockImplementation(
      async () => createHiReplyStream()
    )
    vi.spyOn(app.chatService, "generateTitle").mockResolvedValue("Greeting")

    const chat = await sendChatRequest(app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      message: "Hello",
      model: "qwen/qwen3-8b",
      generationOptions: { temperature: 0.4 }
    })
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/conversations"
    })

    expect(chat.statusCode).toBe(200)
    expect(history.json()).toMatchObject({
      storedCount: 1,
      conversations: [
        { title: "Greeting", preview: { role: "assistant", content: "Hi" } }
      ]
    })
  })

  it("decorates the agent tools Settings lists, which the tool list serves after the built-in tools", async () => {
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(new CapturedLogDestination())
    })
    onTestFinished(async () => await app.close())
    await app.ready()

    const response = await app.inject({ method: "GET", url: "/api/v1/tools" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      tools: [
        { name: "read_page" },
        { name: "web_search" },
        { name: DELEGATE_WORK_TOOL_NAME, runner: "backend" }
      ]
    })
  })

  it("decorates the delegation hooks, which give a member work and log the job message with its logger", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    createModelSpies(app)
    app.agentService.createAgent(FIRST_MEMBER_DEFINITION)
    const delegating = createPersonTurn(app.conversationTurns)
    const conversationId = delegating.turn.conversation.id
    const draft = createJobMessageDraft(
      app.replyParts,
      delegating,
      MOTHS_REQUEST
    )
    const delegation = app.createTurnDelegation(delegating)

    const outcome = delegation.createJobMessage(draft)
    const job = await waitForFirstJobReplyEnd(app, conversationId)

    expect(outcome).toMatchObject({ status: "sent", jobNumber: 1 })
    expect(log.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "An agent gave work to another agent",
        conversationId,
        jobId: job.id,
        jobNumber: 1,
        agentCode: "researcher",
        isNewJob: true
      })
    )
    expect(
      app.conversationHistoryReader.getConversation(job.id)?.messages
    ).toMatchObject([
      { role: "user", content: "Find what moths eat" },
      { id: job.replyId, status: "completed" }
    ])
  })

  it("decorates the person's stop of a reply, which the reply-stop route uses, and logs the stop with its logger", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const lead = createPersonTurn(app.conversationTurns)
    const conversationId = lead.turn.conversation.id
    const assistantMessageId = lead.turn.assistantMessage.id
    const replyTask = startControlledReply(app, {
      conversationId,
      assistantMessageId
    })

    const replyStop = app.inject({
      method: stopChatReplyApi.method,
      url: stopChatReplyApi.path
        .replace(":conversationId", conversationId)
        .replace(":assistantMessageId", assistantMessageId)
    })
    await vi.waitFor(() => {
      expect(replyTask.context.abortSignal.aborted).toBe(true)
    })
    replyTask.resolve()
    const response = await replyStop

    expect(response.statusCode).toBe(204)
    expect(
      log.records.filter(
        (record) => record["msg"] === "Jobs were asked to stop"
      )
    ).toEqual([
      expect.objectContaining({
        level: "info",
        conversationId,
        requester: "person",
        stoppedReplyCount: 1
      })
    ])
  })

  it("decorates the person's stop of a conversation's jobs, which the jobs-stop route uses, and logs the stop with its logger", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const lead = createPersonTurn(app.conversationTurns)
    const conversationId = lead.turn.conversation.id

    const response = await app.inject({
      method: stopConversationJobsApi.method,
      url: stopConversationJobsApi.path.replace(
        ":conversationId",
        conversationId
      )
    })

    expect(response.statusCode).toBe(204)
    expect(
      log.records.filter(
        (record) => record["msg"] === "Jobs were asked to stop"
      )
    ).toEqual([
      expect.objectContaining({
        level: "info",
        conversationId,
        requester: "person",
        stoppedReplyCount: 0
      })
    ])
  })

  it("decorates the listing and cancellation of a deleted conversation's work, which the delete route uses to cancel its reply and title request, and logs the cancellation with its logger", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const lead = createPersonTurn(app.conversationTurns)
    const conversationId = lead.turn.conversation.id
    const replyTask = new ControlledReplyTask()
    const titleTask = new ControlledReplyTask()
    app.replyGenerations.startReplyGeneration(
      { conversationId, assistantMessageId: lead.turn.assistantMessage.id },
      {
        startReplyTask: (context) => replyTask.start(context),
        startTitleTask: (context) => titleTask.start(context),
        reportTaskFailure: vi.fn()
      }
    )
    onTestFinished(() => {
      replyTask.resolve()
      titleTask.resolve()
    })

    const deletion = app.inject({
      method: deleteConversationApi.method,
      url: deleteConversationApi.path.replace(":conversationId", conversationId)
    })
    await vi.waitFor(() => {
      expect(replyTask.context.abortSignal.aborted).toBe(true)
      expect(titleTask.context.abortSignal.aborted).toBe(true)
    })
    replyTask.resolve()
    titleTask.resolve()
    const response = await deletion

    expect(response.statusCode).toBe(204)
    expect(
      app.conversationHistoryReader.getConversationMetadata(conversationId)
    ).toBeUndefined()
    expect(
      log.records.filter(
        (record) => record["msg"] === "Jobs were asked to stop"
      )
    ).toEqual([
      expect.objectContaining({
        level: "info",
        conversationId,
        requester: "person",
        stoppedReplyCount: 1
      })
    ])
  })

  it("ends every running reply generation of the decorated registry before it closes its HTTP server", async () => {
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(new CapturedLogDestination())
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const closeServer = vi.spyOn(app.server, "close")
    const replyTask = new ControlledReplyTask()
    app.replyGenerations.startReplyGeneration(
      {
        conversationId: createFixtureUuidV7(1),
        assistantMessageId: createFixtureUuidV7(2)
      },
      {
        startReplyTask: (context) => replyTask.start(context),
        startTitleTask: undefined,
        reportTaskFailure: vi.fn()
      }
    )
    onTestFinished(() => {
      replyTask.resolve()
    })

    const closing = app.close()
    await vi.waitFor(() => {
      expect(replyTask.context.abortSignal.aborted).toBe(true)
    })
    const serverCloseCountWhileGenerating = closeServer.mock.calls.length
    replyTask.resolve()
    await closing

    expect(serverCloseCountWhileGenerating).toBe(0)
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it("closes the wake settings before it ends the running reply generations, so a lead's reply that completes while it closes starts no wake-up turn", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    createModelSpies(app)
    app.agentService.createAgent(FIRST_MEMBER_DEFINITION)
    const delegating = createPersonTurn(app.conversationTurns)
    const conversationId = delegating.turn.conversation.id
    const leadReplyId = delegating.turn.assistantMessage.id
    const draft = createJobMessageDraft(
      app.replyParts,
      delegating,
      MOTHS_REQUEST
    )
    app.createTurnDelegation(delegating).createJobMessage(draft)
    // The job's result now waits for the lead's reply, which still streams.
    await waitForFirstJobReplyEnd(app, conversationId)
    const replyTask = startControlledReply(app, {
      conversationId: createFixtureUuidV7(1),
      assistantMessageId: createFixtureUuidV7(2)
    })

    const closing = app.close()
    await vi.waitFor(() => {
      expect(replyTask.context.abortSignal.aborted).toBe(true)
    })
    app.conversationTurns.updateAssistantMessageState(leadReplyId, {
      status: "completed",
      finishReason: "stop"
    })
    app.handleReplyEnded({
      conversationId,
      assistantMessageId: leadReplyId,
      errorMessage: undefined
    })
    replyTask.resolve()
    await closing

    expect(log.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "A wake-up turn did not start",
        conversationId,
        reason: "shutting-down"
      })
    )
    expect(log.records).not.toContainEqual(
      expect.objectContaining({ msg: "A wake-up turn started" })
    )
  })

  it("ends an open activity stream when it closes, while a reply generation still runs and before it closes its HTTP server", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const closeServer = vi.spyOn(app.server, "close")
    const replyTask = new ControlledReplyTask()
    app.replyGenerations.startReplyGeneration(
      {
        conversationId: createFixtureUuidV7(1),
        assistantMessageId: createFixtureUuidV7(2)
      },
      {
        startReplyTask: (context) => replyTask.start(context),
        startTitleTask: undefined,
        reportTaskFailure: vi.fn()
      }
    )
    onTestFinished(() => {
      replyTask.resolve()
    })
    const streamResponse = app.inject({
      method: "GET",
      url: "/api/v1/activity/events",
      headers: { accept: "text/event-stream" }
    })
    await vi.waitFor(() => {
      expect(log.records).toContainEqual(
        expect.objectContaining({ msg: "Activity stream connected" })
      )
    })

    const closing = app.close()
    // The reply task is still pending here, so the stream ends without
    // waiting for the generation the close is ending.
    const response = await streamResponse
    const serverCloseCountWhenStreamEnded = closeServer.mock.calls.length
    replyTask.resolve()
    await closing

    expect(response.statusCode).toBe(200)
    expect(parseSseEvents(response.body)).toEqual([
      {
        event: "activity-snapshot",
        data: { type: "activity-snapshot", replies: [] }
      }
    ])
    expect(serverCloseCountWhenStreamEnded).toBe(0)
  })

  it("closes with a working job: the job's reply is interrupted, its report is stored, no wake-up starts, and the activity stream ends", async () => {
    const log = new CapturedLogDestination()
    const config = createOwnedBackendConfig()
    const app = await buildApp({ config, logger: createBackendLogger(log) })
    onTestFinished(async () => await app.close())
    await app.ready()
    const { conversationId, job } = await startWorkingJob(app)
    const streamResponse = app.inject({
      method: "GET",
      url: "/api/v1/activity/events",
      headers: { accept: "text/event-stream" }
    })
    await vi.waitFor(() => {
      expect(log.records).toContainEqual(
        expect.objectContaining({ msg: "Activity stream connected" })
      )
    })

    await app.close()

    const response = await streamResponse
    // A records connection of its own reads what the closed backend left,
    // without the startup recovery a backend runs when it opens.
    const records = openSqliteConversationRecords(config.databaseFilePath)
    expect(records.recordReader.findConversation(conversationId)?.jobs).toEqual(
      [{ ...job, state: "interrupted" }]
    )
    expect(records.listJobReports()).toEqual([
      {
        id: expect.any(String),
        jobId: job.id,
        replyId: job.replyId,
        kind: "interrupted",
        title: "Moths",
        content: "",
        sourceNumbers: [],
        createdAt: expect.any(String),
        deliveredMessageId: null
      }
    ])
    expect(log.records).not.toContainEqual(
      expect.objectContaining({ msg: "A wake-up turn started" })
    )
    expect(response.statusCode).toBe(200)
    expect(parseSseEvents(response.body)).toMatchObject([
      { data: { replies: [{ assistantMessageId: job.replyId }] } }
    ])
  })

  it("logs a request by its full URL, query string included", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const logCountBeforeRequest = log.records.length

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?query=trip%20to%20Hanoi&limit=20"
    })

    expect(response.statusCode).toBe(200)
    expect(log.records.slice(logCountBeforeRequest)).toContainEqual(
      expect.objectContaining({
        msg: "incoming request",
        req: {
          method: "GET",
          url: "/api/v1/conversations?query=trip%20to%20Hanoi&limit=20",
          host: "localhost:80",
          remoteAddress: "127.0.0.1"
        }
      })
    )
  })

  it("logs a request for a route that does not exist with a line of its own", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const logCountBeforeRequest = log.records.length

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/missing?query=trip%20to%20Hanoi"
    })

    expect(response.statusCode).toBe(404)
    expect(log.records.slice(logCountBeforeRequest)).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "incoming request",
        req: expect.objectContaining({
          url: "/api/v1/missing?query=trip%20to%20Hanoi"
        })
      }),
      expect.objectContaining({
        level: "info",
        msg: "Route GET:/api/v1/missing?query=trip%20to%20Hanoi not found"
      }),
      expect.objectContaining({
        level: "info",
        msg: "request completed",
        res: { statusCode: 404 }
      })
    ])
  })

  it("logs the messages of the LM Studio SDK client it connects with to the given logger", async () => {
    fakeLmStudio.operations = {
      ...fakeLmStudio.operations,
      constructClient: (options) => {
        // The SDK logs through the logger it was given, as when LM Studio
        // refuses its connection.
        options.logger?.warn(
          "[LMStudioClient][System]",
          "WebSocket connection refused."
        )
      }
    }
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(log)
    })
    onTestFinished(async () => await app.close())
    await app.ready()

    await app.llmRuntimeService.connectLlmRuntime()

    expect(log.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "[LMStudioClient][System] WebSocket connection refused."
      })
    )
  })

  it("keeps serving when writing its log fails", async () => {
    const logWrites: string[] = []
    const errorWrites: string[] = []
    const standardOutput = createFailingOutput(
      new Error("ENOSPC: no space left on device, write"),
      (text) => {
        logWrites.push(text)
      }
    )
    const standardError = createWorkingOutput((text) => {
      errorWrites.push(text)
    })
    registerOutputFailureListeners(standardOutput, standardError)
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(standardOutput)
    })
    onTestFinished(async () => await app.close())
    await app.ready()

    const first = await app.inject({ method: "GET", url: "/api/v1/heath" })
    const second = await app.inject({ method: "GET", url: "/api/v1/heath" })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(logWrites).toEqual([
      expect.stringContaining('"msg":"incoming request"'),
      expect.stringContaining('"msg":"request completed"'),
      expect.stringContaining('"msg":"incoming request"'),
      expect.stringContaining('"msg":"request completed"')
    ])
    expect(errorWrites).toEqual([
      expect.stringContaining(
        "The Lys backend could not write to its standard output"
      )
    ])
  })

  it("applies the mcp settings group once ready and serves the MCP servers' states", async () => {
    const app = await buildApp({
      config: createConfigWithMcpServers([
        buildFakeStdioServerSettings("files")
      ]),
      logger: createBackendLogger(new CapturedLogDestination())
    })
    onTestFinished(async () => await app.close())
    await app.ready()

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/mcp/servers"
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      settings: "applied",
      servers: [
        {
          name: "email",
          transport: "stdio",
          isBuiltIn: true,
          state: { status: "off" }
        },
        {
          name: "files",
          transport: "stdio",
          isBuiltIn: false,
          state: expect.objectContaining({ status: expect.any(String) })
        }
      ]
    })
  })

  it(
    "logs what an MCP server does and ends its process when it closes",
    async () => {
      const log = new CapturedLogDestination()
      const app = await buildApp({
        config: createConfigWithMcpServers([
          buildFakeStdioServerSettings("files", { reportProcessId: true })
        ]),
        logger: createBackendLogger(log)
      })
      onTestFinished(async () => await app.close())
      await app.ready()

      const processId = await vi.waitFor(
        () => {
          expect(log.records).toContainEqual(
            expect.objectContaining({
              level: "info",
              mcpServer: "files",
              msg: "MCP server connected"
            })
          )
          return readLoggedProcessId(log)
        },
        { timeout: MCP_SERVER_WAIT_MILLISECONDS }
      )
      onTestFinished(() => {
        if (isProcessRunning(processId)) process.kill(processId)
      })
      await app.close()

      expect(isProcessRunning(processId)).toBe(false)
    },
    2 * MCP_SERVER_WAIT_MILLISECONDS
  )

  it(
    "lists an MCP server's process group in the configured file and ends it through the decorated holder, as the backend's stop does",
    async () => {
      const log = new CapturedLogDestination()
      const config = createConfigWithMcpServers([
        buildFakeStdioServerSettings("files", { reportProcessId: true })
      ])
      const app = await buildApp({ config, logger: createBackendLogger(log) })
      onTestFinished(async () => await app.close())
      await app.ready()
      const processId = await vi.waitFor(() => readLoggedProcessId(log), {
        timeout: MCP_SERVER_WAIT_MILLISECONDS
      })
      onTestFinished(() => {
        if (isProcessRunning(processId)) process.kill(processId, "SIGKILL")
      })
      expect(readFileSync(config.mcpProcessGroupsFilePath, "utf8")).toBe(
        `${processId}\n`
      )

      expect(app.mcpServerProcessGroups.stopEveryGroup()).toEqual([])

      await vi.waitFor(
        () => {
          expect(isProcessRunning(processId)).toBe(false)
        },
        { timeout: MCP_SERVER_WAIT_MILLISECONDS }
      )
      expect(readFileSync(config.mcpProcessGroupsFilePath, "utf8")).toBe("")
    },
    2 * MCP_SERVER_WAIT_MILLISECONDS
  )

  it("accepts a request body at the limit and refuses a larger one before the route runs", async () => {
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logger: createBackendLogger(new CapturedLogDestination())
    })
    onTestFinished(async () => await app.close())
    await app.ready()

    const atLimit = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { "content-type": "application/json" },
      payload: createAgentBodyOfSize("at-limit", REQUEST_BODY_LIMIT)
    })
    const overLimit = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { "content-type": "application/json" },
      payload: createAgentBodyOfSize("over-limit", REQUEST_BODY_LIMIT + 1)
    })

    expect(atLimit.statusCode).toBe(201)
    expect(overLimit.statusCode).toBe(413)
    expect(overLimit.json()).toMatchObject({
      code: "FST_ERR_CTP_BODY_TOO_LARGE"
    })
    expect(app.agentService.findAgent("over-limit")).toBeUndefined()
  })
})
