import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import * as z from "zod"
import { buildApp } from "../../src/app"
import type { BackendConfig } from "../../src/config"
import { registerOutputFailureListeners } from "../../src/log"
import AgentService from "../../src/modules/agent/agentService"
import AttachmentFileStore from "../../src/modules/attachment/attachmentFileStore"
import StoredConversationHistoryEditor from "../../src/modules/conversation/historyEditor"
import StoredConversationHistoryReader from "../../src/modules/conversation/historyReader"
import StoredReplyParts from "../../src/modules/conversation/replyParts"
import StoredConversationTurns from "../../src/modules/conversation/turns"
import { TEST_BACKEND_CONFIG } from "./support/backendConfig"
import {
  createNewConversationTarget,
  createTurnUserMessage
} from "./support/conversationFixtures"
import { CapturedLogDestination } from "./support/fastifyTestApp"
import {
  fakeLmStudio,
  type FakeLmStudioOperations
} from "./support/lmStudioSdkFake"
import { createFailingOutput, createWorkingOutput } from "./support/testOutputs"

vi.mock("@lmstudio/sdk", () => import("./support/lmStudioSdkFake"))

/**
 * Creates a configuration that satisfies `backendConfigSchema`, with the
 * conversation database in a temporary directory owned by the current test.
 *
 * @returns The test configuration; the directory exists, so a store opened on
 * its database path would create the file. The directory is removed when the
 * test finishes.
 */
function createOwnedBackendConfig(): BackendConfig {
  const directory = mkdtempSync(join(tmpdir(), "lys-app-test-"))
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    ...TEST_BACKEND_CONFIG,
    databaseFilePath: join(directory, "lys_db.sqlite")
  }
}

/** Fastify's default request body limit, in bytes, stated in the API reference. */
const REQUEST_BODY_LIMIT = 1_048_576

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

    const build = buildApp({
      config,
      logDestination: new CapturedLogDestination()
    })

    await expect(build).rejects.toBeInstanceOf(z.ZodError)
    await expect(build).rejects.toMatchObject({
      issues: [{ path: ["backendHost"] }]
    })
    expect(constructClient).not.toHaveBeenCalled()
    expect(existsSync(config.databaseFilePath)).toBe(false)
  })

  it("decorates the conversation adapters, the agent service, and the attachment file store and serves history and agents from the configured database", async () => {
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logDestination: new CapturedLogDestination()
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
      logDestination: new CapturedLogDestination()
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

  it("writes each log line to the given destination with its level name and its UTC ISO-8601 time", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logDestination: log
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    vi.useFakeTimers({ toFake: ["Date"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const requestTime = "2026-10-21T08:15:02.123Z"
    vi.setSystemTime(new Date(requestTime))
    const logCountBeforeRequest = log.records.length

    await app.inject({ method: "GET", url: "/api/v1/heath" })

    expect(log.records.slice(logCountBeforeRequest)).toEqual([
      expect.objectContaining({
        level: "info",
        time: requestTime,
        msg: "incoming request"
      }),
      expect.objectContaining({
        level: "info",
        time: requestTime,
        msg: "request completed"
      })
    ])
  })

  it("writes info lines and leaves out debug lines", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logDestination: log
    })
    onTestFinished(async () => await app.close())
    await app.ready()

    app.log.debug("Detail written at debug level")
    app.log.info("Detail written at info level")

    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "Detail written at info level" })
    )
    expect(log.records).not.toContainEqual(
      expect.objectContaining({ msg: "Detail written at debug level" })
    )
  })

  it("logs a request by its path without the query string, so a search is not kept", async () => {
    const log = new CapturedLogDestination()
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logDestination: log
    })
    onTestFinished(async () => await app.close())
    await app.ready()
    const logCountBeforeRequest = log.records.length

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?query=my%20private%20search&limit=20"
    })

    const requestRecords = log.records.slice(logCountBeforeRequest)
    expect(response.statusCode).toBe(200)
    expect(requestRecords).toContainEqual(
      expect.objectContaining({
        msg: "incoming request",
        req: {
          method: "GET",
          url: "/api/v1/conversations",
          host: "localhost:80",
          remoteAddress: "127.0.0.1"
        }
      })
    )
    expect(JSON.stringify(requestRecords)).not.toContain("private")
  })

  it("keeps serving when writing its log fails", async () => {
    const logWrites: string[] = []
    const errorWrites: string[] = []
    const logDestination = createFailingOutput(
      new Error("ENOSPC: no space left on device, write"),
      (text) => {
        logWrites.push(text)
      }
    )
    const standardError = createWorkingOutput((text) => {
      errorWrites.push(text)
    })
    registerOutputFailureListeners(logDestination, standardError)
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logDestination
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

  it("accepts a request body at the limit and refuses a larger one before the route runs", async () => {
    const app = await buildApp({
      config: createOwnedBackendConfig(),
      logDestination: new CapturedLogDestination()
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
