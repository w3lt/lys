import { chatContextApi } from "@lys/protocol"
import type { BuiltInAgent } from "@lys/share"
import { serializerCompiler } from "fastify-type-provider-zod"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import SqliteAgentRecordStore from "../../../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import AgentService from "../../../../../src/modules/agent/agentService"
import { formatSystemPrompt } from "../../../../../src/modules/agent/agentContext"
import { TOOL_CALLS_OFF } from "../../../../../src/modules/agent/unofferedTools"
import type { ReplyModel } from "../../../../../src/modules/agent/replyModel"
import AttachmentFileStore from "../../../../../src/modules/attachment/attachmentFileStore"
import { buildReadAttachmentDefinition } from "../../../../../src/modules/attachment/readAttachmentTool"
import registerChatContextRoute from "../../../../../src/modules/chat/routes/chatContextRoute"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import LlmService from "../../../../../src/modules/llm/llmService"
import type { DownloadedLlmModel } from "../../../../../src/modules/llm/llmRuntimeTypes"
import AgentTool from "../../../../../src/modules/tool/tool"
import {
  createImageAttachment,
  createPngBytes,
  createTextAttachment
} from "../../../support/attachmentFixtures"
import {
  openConversationTestServices,
  saveAssistantMessageRow,
  saveConversationRow,
  saveUserMessageRow
} from "../../../support/conversationDatabase"
import {
  createFixtureUuidV7,
  createTextPart
} from "../../../support/conversationFixtures"
import { createTestFastify } from "../../../support/fastifyTestApp"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"
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

/** Text of the stored conversation's completed reply. */
const EARLIER_ANSWER_PART = createTextPart({
  sequence: 13,
  round: 0,
  content: "Earlier answer",
  times: {
    createdAt: "2026-10-15T10:00:02.000Z",
    updatedAt: "2026-10-15T10:00:03.000Z"
  }
})

/** Text of the stored conversation's failed reply. */
const FAILED_ANSWER_PART = createTextPart({
  sequence: 15,
  round: 0,
  content: "Failed answer",
  times: {
    createdAt: "2026-10-15T10:00:05.000Z",
    updatedAt: "2026-10-15T10:00:06.000Z"
  }
})

/** The model as the inventory lists it when it sees images. */
const VISION_MODEL_INFO: DownloadedLlmModel = Object.freeze({
  ...createDownloadedLlmModel({ modelKey: MODEL }),
  vision: true,
  trainedForToolUse: true
})

/**
 * Creates an application with the chat-context route over a real agent
 * service and conversation reader on an in-memory database owned by the
 * current test.
 *
 * @returns The application, the database for seeding rows, the context
 * meter spy every agent measures with, which every context fits by default,
 * the downloaded-model spy, which rejects until a case configures it, and the
 * attachment file store, over a directory removed when the test finishes.
 */
async function createChatContextRouteApp() {
  const { app } = createTestFastify()
  const { database, history } = openConversationTestServices()
  const replyContextMeter = createRoomyReplyContextMeter()
  const attachmentsDirectoryPath = mkdtempSync(
    join(tmpdir(), "lys-chat-context-attachments-")
  )
  onTestFinished(() => {
    rmSync(attachmentsDirectoryPath, { recursive: true, force: true })
  })
  const attachmentFileStore = new AttachmentFileStore(attachmentsDirectoryPath)
  const llmService = new LlmService({
    llmEngineOperationQueue: Object.freeze({
      handleLlmEngineOperationRequest: () =>
        Promise.reject(new Error("Unexpected LLM engine operation"))
    })
  })
  const listDownloadedLlmModels = vi
    .spyOn(llmService, "listDownloadedLlmModels")
    .mockRejectedValue(
      new Error("Unexpected context route call: listDownloadedLlmModels")
    )
  await updateFastifyWithHttpTransport(app)
  app.decorate("llmService", llmService)
  app.decorate("attachmentFileStore", attachmentFileStore)
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
  return {
    app,
    database,
    replyContextMeter,
    listDownloadedLlmModels,
    attachmentFileStore
  }
}

/**
 * Stores a conversation whose only message carries one attachment.
 *
 * @param database - Database of the case's application.
 * @param attachment - The stored attachment.
 */
function saveConversationWithAttachment(
  database: Awaited<ReturnType<typeof createChatContextRouteApp>>["database"],
  attachment: ReturnType<typeof createImageAttachment>
): void {
  saveConversationRow(database, {
    id: STORED_CONVERSATION_ID,
    title: null,
    agentCode: "caliginia",
    createdAt: "2026-10-15T10:00:00.000Z"
  })
  saveUserMessageRow(database, {
    id: createFixtureUuidV7(2),
    conversationId: STORED_CONVERSATION_ID,
    content: "Look at this",
    createdAt: "2026-10-15T10:00:01.000Z",
    attachments: [attachment]
  })
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
    parts: [EARLIER_ANSWER_PART],
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
    parts: [FAILED_ANSWER_PART],
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

/**
 * Builds distinct valid tool names.
 *
 * @param count - Number of names.
 * @returns `tool_0`, `tool_1`, and so on, `count` names in all.
 */
function buildToolNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `tool_${index}`)
}

describe("registerChatContextRoute", () => {
  it("measures a new conversation with its agent's system prompt and the offered tools, as a turn sends them", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
      contextLength: 8192,
      messageTokenCounts: [2260, 9],
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
      historyMessageCount: 0,
      messageMarkupTokens: 9
    })
    expect(
      replyContextMeter.findReplyContextMeasurement
    ).toHaveBeenCalledExactlyOnceWith({
      messages: [
        { role: "system", content: CALIGINIA.systemPrompt },
        { role: "user", content: "", images: [] }
      ],
      tools: [
        new AgentTool(READ_TEXT_FILE_TOOL).buildAgentFormat(),
        new AgentTool(LOOK_UP_WORD_TOOL).buildAgentFormat()
      ],
      model: MODEL
    })
  })

  it("measures the note that names the switched-off tools with the agent's system prompt, as a turn sends it", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
      contextLength: 8192,
      messageTokenCounts: [2310, 9],
      toolTokenCount: 205
    })

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      model: MODEL,
      tools: { definitions: [READ_TEXT_FILE_TOOL] },
      switchedOffToolNames: ["web_search", "search_files"]
    })

    expect(response.statusCode).toBe(200)
    expect(chatContextApi.responses[200].parse(response.json())).toMatchObject({
      systemPromptTokens: 2310
    })
    expect(
      replyContextMeter.findReplyContextMeasurement
    ).toHaveBeenCalledExactlyOnceWith({
      messages: [
        {
          role: "system",
          content: formatSystemPrompt(CALIGINIA.systemPrompt, {
            status: "tool-calls-on",
            switchedOffToolNames: ["web_search", "search_files"],
            unavailableTools: []
          })
        },
        { role: "user", content: "", images: [] }
      ],
      tools: [new AgentTool(READ_TEXT_FILE_TOOL).buildAgentFormat()],
      model: MODEL
    })
  })

  it("measures the note that names the switched-on tools that cannot run, with why, as a turn sends it", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
      contextLength: 8192,
      messageTokenCounts: [2330, 9],
      toolTokenCount: 205
    })

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      model: MODEL,
      tools: { definitions: [READ_TEXT_FILE_TOOL] },
      unavailableTools: [{ name: "check_spelling", reason: "api-key-missing" }]
    })

    expect(response.statusCode).toBe(200)
    expect(
      replyContextMeter.findReplyContextMeasurement
    ).toHaveBeenCalledExactlyOnceWith({
      messages: [
        {
          role: "system",
          content: formatSystemPrompt(CALIGINIA.systemPrompt, {
            status: "tool-calls-on",
            switchedOffToolNames: [],
            unavailableTools: [
              { name: "check_spelling", reason: "api-key-missing" }
            ]
          })
        },
        { role: "user", content: "", images: [] }
      ],
      tools: [new AgentTool(READ_TEXT_FILE_TOOL).buildAgentFormat()],
      model: MODEL
    })
  })

  it("measures the note that says tool calls are off, with no tool offered", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
      contextLength: 8192,
      messageTokenCounts: [2290, 9],
      toolTokenCount: 0
    })

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      model: MODEL,
      areToolCallsSwitchedOff: true
    })

    expect(response.statusCode).toBe(200)
    expect(
      replyContextMeter.findReplyContextMeasurement
    ).toHaveBeenCalledExactlyOnceWith({
      messages: [
        {
          role: "system",
          content: formatSystemPrompt(CALIGINIA.systemPrompt, TOOL_CALLS_OFF)
        },
        { role: "user", content: "", images: [] }
      ],
      tools: [],
      model: MODEL
    })
  })

  it("accepts 64 switched-off tools, the most a request names", async () => {
    const { app, replyContextMeter } = await createChatContextRouteApp()
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
      contextLength: 8192,
      messageTokenCounts: [2900, 9],
      toolTokenCount: 0
    })

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      model: MODEL,
      switchedOffToolNames: buildToolNames(64)
    })

    expect(response.statusCode).toBe(200)
  })

  it("measures the stored messages a continued conversation's next turn would include", async () => {
    const { app, database, replyContextMeter } =
      await createChatContextRouteApp()
    saveStoredConversation(database, "caliginia")
    replyContextMeter.findReplyContextMeasurement.mockResolvedValue({
      contextLength: 8192,
      messageTokenCounts: [2260, 10, 20, 30, 9],
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
      historyMessageCount: 3,
      messageMarkupTokens: 9
    })
    expect(
      replyContextMeter.findReplyContextMeasurement
    ).toHaveBeenCalledExactlyOnceWith({
      messages: [
        { role: "system", content: CALIGINIA.systemPrompt },
        { role: "user", content: "Earlier question", images: [] },
        { role: "assistant", content: "Earlier answer", toolCalls: [] },
        { role: "user", content: "Second question", images: [] },
        { role: "user", content: "", images: [] }
      ],
      tools: [],
      model: MODEL
    })
  })

  it("measures a stored image from its sides without reading its file, reading from the inventory whether the model sees images", async () => {
    const {
      app,
      database,
      replyContextMeter,
      listDownloadedLlmModels,
      attachmentFileStore
    } = await createChatContextRouteApp()
    saveConversationWithAttachment(
      database,
      createImageAttachment(1, "photo.png")
    )
    const png = Buffer.from(createPngBytes(64, 32))
    await attachmentFileStore.saveMessageAttachments(
      STORED_CONVERSATION_ID,
      createFixtureUuidV7(2),
      [{ name: "photo.png", content: png }]
    )
    listDownloadedLlmModels.mockResolvedValue([VISION_MODEL_INFO])
    const readAttachment = vi.spyOn(attachmentFileStore, "readAttachment")

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
      model: MODEL
    })

    expect(response.statusCode).toBe(200)
    expect(replyContextMeter.findReplyContextMeasurement).toHaveBeenCalledOnce()
    expect(
      replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0].messages
    ).toEqual([
      { role: "system", content: CALIGINIA.systemPrompt },
      {
        role: "user",
        content:
          "Look at this\n\nAttached files:\n[attachment 1] photo.png (image/png, 64×32, 33 bytes)",
        images: [{ width: 64, height: 32 }]
      },
      { role: "user", content: "", images: [] }
    ])
    expect(listDownloadedLlmModels).toHaveBeenCalledOnce()
    expect(readAttachment).not.toHaveBeenCalled()
  })

  it("measures a stored image whose file is missing as its placeholder, as a turn sends it", async () => {
    const { app, database, replyContextMeter, listDownloadedLlmModels } =
      await createChatContextRouteApp()
    saveConversationWithAttachment(
      database,
      createImageAttachment(1, "photo.png")
    )
    listDownloadedLlmModels.mockResolvedValue([VISION_MODEL_INFO])

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
      model: MODEL
    })

    expect(response.statusCode).toBe(200)
    expect(
      replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0]
        .messages[1]
    ).toEqual({
      role: "user",
      content:
        "Look at this\n\nAttached files:\n[attachment 1] photo.png (image/png, 64×32, 33 bytes)\n[attachment 1] photo.png is an image whose file is missing from this machine, so it cannot be shown.",
      images: []
    })
  })

  it.each([
    [
      "a model that cannot see images",
      [{ ...VISION_MODEL_INFO, vision: false }]
    ],
    ["a model the inventory does not list", []]
  ])(
    "measures a stored image's placeholder for %s",
    async (_label, inventory) => {
      const { app, database, replyContextMeter, listDownloadedLlmModels } =
        await createChatContextRouteApp()
      saveConversationWithAttachment(
        database,
        createImageAttachment(1, "photo.png")
      )
      listDownloadedLlmModels.mockResolvedValue(inventory)

      const response = await sendChatContextRequest(app, {
        conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
        model: MODEL
      })

      expect(response.statusCode).toBe(200)
      expect(
        replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0]
          .messages[1]
      ).toEqual({
        role: "user",
        content:
          "Look at this\n\nAttached files:\n[attachment 1] photo.png (image/png, 64×32, 33 bytes)\n[attachment 1] photo.png is an image that this model cannot see.",
        images: []
      })
    }
  )

  it("measures a stored text file's listing and, for a model trained for tool use, the attachment reader after the offered tools, as a turn offers it", async () => {
    const { app, database, replyContextMeter, listDownloadedLlmModels } =
      await createChatContextRouteApp()
    saveConversationWithAttachment(
      database,
      createTextAttachment(1, "notes.md", 18)
    )
    listDownloadedLlmModels.mockResolvedValue([
      { ...VISION_MODEL_INFO, vision: false }
    ])

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
      model: MODEL,
      tools: { definitions: [], backendToolNames: ["look_up_word"] }
    })

    expect(response.statusCode).toBe(200)
    expect(listDownloadedLlmModels).toHaveBeenCalledOnce()
    const measured =
      replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0]
    expect(measured?.messages[1]).toEqual({
      role: "user",
      content:
        "Look at this\n\nAttached files:\n[attachment 1] notes.md (text, 18 bytes)",
      images: []
    })
    expect(measured?.tools).toEqual([
      new AgentTool(LOOK_UP_WORD_TOOL).buildAgentFormat(),
      new AgentTool(buildReadAttachmentDefinition()).buildAgentFormat()
    ])
  })

  it.each([
    [
      "a model not trained for tool use",
      [{ ...VISION_MODEL_INFO, trainedForToolUse: false }]
    ],
    ["a model the inventory does not list", []]
  ])(
    "measures a stored text file's listing without the reader for %s",
    async (_label, inventory) => {
      const { app, database, replyContextMeter, listDownloadedLlmModels } =
        await createChatContextRouteApp()
      saveConversationWithAttachment(
        database,
        createTextAttachment(1, "notes.md", 18)
      )
      listDownloadedLlmModels.mockResolvedValue(inventory)

      const response = await sendChatContextRequest(app, {
        conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
        model: MODEL
      })

      expect(response.statusCode).toBe(200)
      expect(
        replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0].tools
      ).toEqual([])
    }
  )

  it("measures a stored image without the reader, as no text file is attached", async () => {
    const { app, database, replyContextMeter, listDownloadedLlmModels } =
      await createChatContextRouteApp()
    saveConversationWithAttachment(
      database,
      createImageAttachment(1, "photo.png")
    )
    listDownloadedLlmModels.mockResolvedValue([VISION_MODEL_INFO])

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
      model: MODEL
    })

    expect(response.statusCode).toBe(200)
    expect(
      replyContextMeter.findReplyContextMeasurement.mock.calls[0]?.[0].tools
    ).toEqual([])
  })

  it("responds with the 503 problem of a full model-operation queue met while the inventory is read, without measuring", async () => {
    const { app, database, replyContextMeter, listDownloadedLlmModels } =
      await createChatContextRouteApp()
    saveConversationWithAttachment(
      database,
      createImageAttachment(1, "photo.png")
    )
    listDownloadedLlmModels.mockRejectedValue(createLlmServiceBusyError())

    const response = await sendChatContextRequest(app, {
      conversation: { kind: "existing", id: STORED_CONVERSATION_ID },
      model: MODEL
    })

    expect(response.statusCode).toBe(503)
    expect(chatContextApi.responses[503].parse(response.json())).toMatchObject({
      type: "urn:lys:problem:llm:service-busy"
    })
    expect(replyContextMeter.findReplyContextMeasurement).not.toHaveBeenCalled()
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
    ],
    [
      "a switched-off tool it also offers as a client tool",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        tools: { definitions: [READ_TEXT_FILE_TOOL] },
        switchedOffToolNames: ["read_text_file"]
      }
    ],
    [
      "a switched-off tool it also offers as a backend tool",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        tools: { definitions: [], backendToolNames: ["look_up_word"] },
        switchedOffToolNames: ["look_up_word"]
      }
    ],
    [
      "the attachment reader switched off",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        switchedOffToolNames: ["read_attachment"]
      }
    ],
    [
      "a switched-off tool named twice",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        switchedOffToolNames: ["web_search", "web_search"]
      }
    ],
    [
      "an empty switched-off list",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        switchedOffToolNames: []
      }
    ],
    [
      "65 switched-off tools",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        switchedOffToolNames: buildToolNames(65)
      }
    ],
    [
      "a switched-off tool name that is not a tool name",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        switchedOffToolNames: ["web search"]
      }
    ],
    [
      "a tool that cannot run that the backend does not run",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        unavailableTools: [{ name: "fetch_url", reason: "api-key-missing" }]
      }
    ],
    [
      "a tool that cannot run it also offers",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        tools: { definitions: [], backendToolNames: ["check_spelling"] },
        unavailableTools: [
          { name: "check_spelling", reason: "api-key-missing" }
        ]
      }
    ],
    [
      "a tool that cannot run it also names as switched off",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        switchedOffToolNames: ["check_spelling"],
        unavailableTools: [
          { name: "check_spelling", reason: "api-key-missing" }
        ]
      }
    ],
    [
      "a tool that cannot run with a reason the contract does not have",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        unavailableTools: [{ name: "check_spelling", reason: "offline" }]
      }
    ],
    [
      "an empty list of tools that cannot run",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        unavailableTools: []
      }
    ],
    [
      "tool calls switched off with a tool offered",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        tools: { definitions: [READ_TEXT_FILE_TOOL] },
        areToolCallsSwitchedOff: true
      }
    ],
    [
      "tool calls switched off with a switched-off tool named",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        switchedOffToolNames: ["web_search"],
        areToolCallsSwitchedOff: true
      }
    ],
    [
      "tool calls switched off with a tool that cannot run named",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        unavailableTools: [
          { name: "check_spelling", reason: "api-key-missing" }
        ],
        areToolCallsSwitchedOff: true
      }
    ],
    [
      "tool calls named as switched on",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL,
        areToolCallsSwitchedOff: false
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
