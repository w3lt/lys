import { chatContextApi } from "@lys/protocol"
import type { BuiltInAgent } from "@lys/share"
import { serializerCompiler } from "fastify-type-provider-zod"
import { describe, expect, it } from "vitest"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import SqliteAgentRecordStore from "../../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import AgentService from "../../../../../src/modules/agent/agentService"
import type { ReplyModel } from "../../../../../src/modules/agent/replyModel"
import registerChatContextRoute from "../../../../../src/modules/chat/routes/chatContextRoute"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import AgentTool from "../../../../../src/modules/tool/tool"
import {
  openConversationTestServices,
  saveAssistantMessageRow,
  saveConversationRow,
  saveUserMessageRow
} from "../../../support/conversationDatabase"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { createTestFastify } from "../../../support/fastifyTestApp"
import { createRoomyReplyContextMeter } from "../../../support/replyContextMeterFakes"
import {
  CHECK_SPELLING_TOOL,
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "../../../support/scriptedBuiltInTool"
import { ScriptedBuiltInToolProvider } from "../../../support/scriptedBuiltInToolProvider"
import { READ_TEXT_FILE_TOOL } from "../../../support/toolFixtures"

/** Built-in agent that answers the cases' conversations. */
const CALIGINIA: BuiltInAgent = Object.freeze({
  code: "caliginia",
  name: "Caliginia",
  bio: "Lys's dark side.",
  systemPrompt: "You are the test Caliginia."
})

/** Model every case names. */
const MODEL = "qwen/qwen3-8b"

/** Model access the chat-context route never uses. */
const UNUSED_REPLY_MODEL = Object.freeze({
  openReplyStream: () =>
    Promise.reject(new Error("Unexpected model call from the context route"))
} satisfies ReplyModel)

/** Conversation every continued-conversation case stores. */
const STORED_CONVERSATION_ID = createFixtureUuidV7(1)

/**
 * Creates an application with the chat-context route over a real agent
 * service and conversation reader on an in-memory database owned by the
 * current test.
 *
 * @returns The application, the database for seeding rows, and the context
 * meter spy every agent measures with; every context fits by default.
 */
async function createChatContextRouteApp() {
  const { app } = createTestFastify()
  const { database, history } = openConversationTestServices()
  const replyContextMeter = createRoomyReplyContextMeter()
  await updateFastifyWithHttpTransport(app)
  app.decorate(
    "agentService",
    new AgentService({
      recordStore: new SqliteAgentRecordStore(database),
      builtInAgents: [CALIGINIA],
      replyModel: UNUSED_REPLY_MODEL,
      replyContextMeter
    })
  )
  app.decorate("conversationHistoryReader", history)
  app.decorate(
    "builtInTools",
    Object.freeze([
      Object.freeze({
        definition: LOOK_UP_WORD_TOOL,
        provider: new ScriptedBuiltInToolProvider({
          status: "ready",
          tool: new ScriptedBuiltInTool()
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
  )
  await app.register(async (scope) => {
    scope.setSerializerCompiler(serializerCompiler)
    registerChatContextRoute(scope)
  })
  return { app, database, replyContextMeter }
}

/**
 * Stores a conversation with a user message, a completed reply, and a failed
 * reply.
 *
 * @param database - Database of the case's application.
 * @param agentCode - Agent code stored with the conversation.
 */
function saveStoredConversation(
  database: Awaited<ReturnType<typeof createChatContextRouteApp>>["database"],
  agentCode: string
): void {
  saveConversationRow(database, {
    id: STORED_CONVERSATION_ID,
    title: null,
    agentCode,
    createdAt: "2026-10-15T10:00:00.000Z"
  })
  saveUserMessageRow(database, {
    id: createFixtureUuidV7(2),
    conversationId: STORED_CONVERSATION_ID,
    content: "Earlier question",
    createdAt: "2026-10-15T10:00:01.000Z"
  })
  saveAssistantMessageRow(database, {
    id: createFixtureUuidV7(3),
    conversationId: STORED_CONVERSATION_ID,
    model: MODEL,
    content: "Earlier answer",
    status: "completed",
    finishReason: "stop",
    createdAt: "2026-10-15T10:00:02.000Z",
    updatedAt: "2026-10-15T10:00:03.000Z"
  })
  saveUserMessageRow(database, {
    id: createFixtureUuidV7(4),
    conversationId: STORED_CONVERSATION_ID,
    content: "Second question",
    createdAt: "2026-10-15T10:00:04.000Z"
  })
  saveAssistantMessageRow(database, {
    id: createFixtureUuidV7(5),
    conversationId: STORED_CONVERSATION_ID,
    model: MODEL,
    content: "Failed answer",
    status: "failed",
    finishReason: null,
    createdAt: "2026-10-15T10:00:05.000Z",
    updatedAt: "2026-10-15T10:00:06.000Z"
  })
}

/**
 * Sends one chat-context request.
 *
 * @param app - Application with the route registered.
 * @param payload - Raw request body, serialized as JSON.
 * @returns The completed response.
 */
async function sendChatContextRequest(
  app: Awaited<ReturnType<typeof createChatContextRouteApp>>["app"],
  payload: unknown
) {
  return await app.inject({
    method: chatContextApi.method,
    url: chatContextApi.path,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload)
  })
}

describe("registerChatContextRoute", () => {
  it("measures a new conversation with its agent's system prompt and the offered tools, as a turn sends them", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
      contextLength: 8192,
      messageTokenCounts: [2260],
      toolTokenCount: 410
    })

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      model: MODEL,
      tools: {
        definitions: [READ_TEXT_FILE_TOOL],
        backendToolNames: ["look_up_word"]
      }
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(chatContextApi.responses[200].parse(response.json())).toEqual({
      contextLength: 8192,
      systemPromptTokens: 2260,
      toolTokens: 410,
      historyTokens: 0,
      historyMessageCount: 0
    })
    expect(
      replyContextMeter.findReplyContextMeasurement
    ).toHaveBeenCalledExactlyOnceWith({
      messages: [{ role: "system", content: CALIGINIA.systemPrompt }],
      tools: [
        new AgentTool(READ_TEXT_FILE_TOOL).buildAgentFormat(),
        new AgentTool(LOOK_UP_WORD_TOOL).buildAgentFormat()
      ],
      model: MODEL
    })
  })

  it("measures the stored messages a continued conversation's next turn would include", async () => {
    const { app, database, replyContextMeter } =
      await createChatContextRouteApp()
    saveStoredConversation(database, "caliginia")
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
      contextLength: 8192,
      messageTokenCounts: [2260, 10, 20, 30],
      toolTokenCount: 0
    })

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
      model: MODEL
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      contextLength: 8192,
      systemPromptTokens: 2260,
      toolTokens: 0,
      historyTokens: 60,
      historyMessageCount: 3
    })
    expect(
      replyContextMeter.findReplyContextMeasurement
    ).toHaveBeenCalledExactlyOnceWith({
      messages: [
        { role: "system", content: CALIGINIA.systemPrompt },
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer", toolCalls: [] },
        { role: "user", content: "Second question" }
      ],
      tools: [],
      model: MODEL
    })
  })

  it("measures an offered backend tool that cannot run now", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      model: MODEL,
      tools: { definitions: [], backendToolNames: ["check_spelling"] }
    })

    expect(response.statusCode).toBe(200)
    expect(
      replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0].tools
    ).toEqual([new AgentTool(CHECK_SPELLING_TOOL).buildAgentFormat()])
  })

  it("responds with the model-not-loaded problem when no loaded instance matches the model", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue(undefined)

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      model: MODEL
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(chatContextApi.responses[503].parse(response.json())).toEqual({
      type: "urn:lys:problem:llm:model-not-loaded",
      title: "Model not loaded",
      status: 503,
      detail:
        "The model is not loaded in LM Studio. Load it in Settings → Model to measure the conversation.",
      instance: chatContextApi.path
    })
  })

  it.each([
    [
      "a full model-operation queue",
      createLlmServiceBusyError(),
      "urn:lys:problem:llm:service-busy"
    ],
    [
      "a missing LLM runtime",
      createLlmRuntimeUnavailableError([]),
      "urn:lys:problem:llm:runtime-unavailable"
    ]
  ])(
    "responds with its 503 problem for %s",
    async (_scenario, failure, problemType) => {
      const { app, replyContextMeter } = await createChatContextRouteApp()
      replyContextMeter.findReplyContextMeasurement.mockRejectedValue(failure)

      const response = await sendChatContextRequest(app, {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL
      })

      expect(response.statusCode).toBe(503)
      expect(
        chatContextApi.responses[503].parse(response.json())
      ).toMatchObject({ type: problemType, status: 503 })
    }
  )

  it("responds with the agent-not-found problem without measuring for a new conversation's unknown agent", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "new", agentCode: "nobody" },
      model: MODEL
    })

    expect(response.statusCode).toBe(404)
    expect(chatContextApi.responses[404].parse(response.json())).toMatchObject({
      type: "urn:lys:problem:agent:not-found"
    })
    expect(replyContextMeter.findReplyContextMeasurement).not.toHaveBeenCalled()
  })

  it("responds with the conversation-not-found problem without measuring for a conversation that is not stored", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
      model: MODEL
    })

    expect(response.statusCode).toBe(404)
    expect(chatContextApi.responses[404].parse(response.json())).toMatchObject({
      type: "urn:lys:problem:conversation:not-found"
    })
    expect(replyContextMeter.findReplyContextMeasurement).not.toHaveBeenCalled()
  })

  it("responds with the conversation-agent-missing problem without measuring when the conversation's agent no longer exists", async () => {
    const { app, database, replyContextMeter } =
      await createChatContextRouteApp()
    saveStoredConversation(database, "deleted-agent")

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
      model: MODEL
    })

    expect(response.statusCode).toBe(409)
    expect(chatContextApi.responses[409].parse(response.json())).toMatchObject({
      type: "urn:lys:problem:conversation:agent-missing",
      detail: expect.stringContaining("deleted-agent")
    })
    expect(replyContextMeter.findReplyContextMeasurement).not.toHaveBeenCalled()
  })

  it.each([
    [
      "a backend tool the backend does not run",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        tools: { definitions: [], backendToolNames: ["unknown_tool"] }
      }
    ],
    [
      "an empty model",
      { conversation: { kind: "new", agentCode: "caliginia" }, model: "" }
    ],
    [
      "a message field the contract does not have",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        message: "Hello"
      }
    ]
  ])(
    "rejects a request with %s without measuring",
    async (_scenario, payload) => {
      const { app, replyContextMeter } = await createChatContextRouteApp()

      const response = await sendChatContextRequest(app, payload)

      expect(response.statusCode).toBe(400)
      expect(
        replyContextMeter.findReplyContextMeasurement
      ).not.toHaveBeenCalled()
    }
  )
})
