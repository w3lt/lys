import {
  agentNotFoundProblemSchema,
  chatApi,
  chatAttachmentUnsupportedProblemSchema,
  chatBackendToolUnavailableProblemSchema,
  chatApiStreamEventSchema,
  chatImageNeedsVisionProblemSchema,
  conversationAgentMissingProblemSchema,
  conversationNotFoundProblemSchema,
  type LlmInfo
} from "@lys/protocol"
import {
  MAXIMUM_ATTACHMENT_BYTES,
  MAXIMUM_MESSAGE_ATTACHMENT_BYTES
} from "@lys/share"
import type { LightMyRequestResponse } from "fastify"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type ReplyGeneration from "../../../../../src/modules/chat/replyGeneration"
import updateFastifyWithChatRoute, {
  type ChatRouteOptions
} from "../../../../../src/modules/chat/routes/chatRoute"
import { createLlmRuntimeUnavailableError } from "../../../../../src/modules/llm/llmRuntimeUnavailableError"
import { createLlmServiceBusyError } from "../../../../../src/modules/llm/llmServiceBusyError"
import { ChatCompletionCancelledError } from "../../../../../src/utils/errors"
import {
  createPngBytes,
  buildAttachmentContent
} from "../../../support/attachmentFixtures"
import {
  createChatRouteTestApp,
  sendChatRequest,
  TEST_BUILT_IN_AGENT_PROMPTS,
  type ChatRouteTestApp
} from "../../../support/chatRouteTestApp"
import { parseSseEvents } from "../../../support/chatSseRoute"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"
import { createChatCompletionChunk } from "../../../support/openAiEndpointFake"
import { LOOK_UP_WORD_FORMAT } from "../../../support/scriptedBuiltInTool"
import {
  READ_TEXT_FILE_FORMAT,
  READ_TEXT_FILE_TOOL
} from "../../../support/toolFixtures"

/** Settings applied by the chat route in every case. */
const CHAT_ROUTE_OPTIONS = Object.freeze({
  titleGenerationMaxAttempts: 2
} satisfies ChatRouteOptions)

/** Valid request body starting a new conversation that Caliginia answers. */
const NEW_CONVERSATION_REQUEST = Object.freeze({
  conversation: { kind: "new", agentCode: "caliginia" },
  message: "Plan my trip",
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4 }
})

/**
 * Builds the request form of a text attachment.
 *
 * @param name - Attachment name.
 * @param text - Its UTF-8 text.
 * @returns The attachment as a chat request carries it.
 */
function buildTextAttachmentPayload(
  name: string,
  text: string
): { name: string; content: string } {
  return {
    name,
    content: buildAttachmentContent(new TextEncoder().encode(text))
  }
}

/**
 * Builds the request form of a text file of a given size, filled with
 * spaces, so only its size can refuse it.
 *
 * @param name - Attachment name.
 * @param sizeBytes - Size of the file.
 * @returns The attachment as a chat request carries it.
 */
function buildSizedTextAttachmentPayload(
  name: string,
  sizeBytes: number
): { name: string; content: string } {
  return buildTextAttachmentPayload(name, " ".repeat(sizeBytes))
}

/** Definition of the stored agent that answers some cases' conversations. */
const WEB_RESEARCHER_DEFINITION = Object.freeze({
  code: "web-researcher",
  name: "Web Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web."
})

/** Valid request body starting a conversation the stored agent answers. */
const WEB_RESEARCHER_REQUEST = Object.freeze({
  ...NEW_CONVERSATION_REQUEST,
  conversation: { kind: "new", agentCode: "web-researcher" }
})

/**
 * Registers the chat route on a test application whose turns are stored for
 * real, with a model that answers `Hi` and a title generator that answers
 * `Trip plan`.
 *
 * @param testApp - Test application without the chat route.
 */
function registerStoringChatRoute(testApp: ChatRouteTestApp): void {
  testApp.createConversationTurn.mockRestore()
  testApp.completeChatStream.mockImplementation(async () =>
    (async function* () {
      yield createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
    })()
  )
  testApp.generateTitle.mockResolvedValue("Trip plan")
  updateFastifyWithChatRoute(testApp.app, {
    ...CHAT_ROUTE_OPTIONS,
    generations: testApp.generations
  })
}

/**
 * Starts a conversation the stored web researcher answers and waits for its
 * first reply.
 *
 * @param testApp - Test application registered by
 * {@link registerStoringChatRoute}.
 * @returns UUIDv7 of the stored conversation.
 */
async function startWebResearcherConversation(
  testApp: ChatRouteTestApp
): Promise<string> {
  testApp.app.agentService.createAgent(WEB_RESEARCHER_DEFINITION)
  const response = await sendChatRequest(testApp.app, WEB_RESEARCHER_REQUEST)
  const start = chatApiStreamEventSchema.parse(
    parseSseEvents(response.body)[0]?.data
  )
  if (start.type !== "start-new-conversation-turn")
    throw new Error("The chat route did not start a new conversation")
  return start.conversation.id
}

/**
 * Creates a stream of fixed chat completion chunks.
 *
 * @param chunks - Chunks yielded in order.
 * @returns An iterator that yields each chunk in order and ends after the
 * last one.
 */
async function* createChunkStream(
  ...chunks: ReturnType<typeof createChatCompletionChunk>[]
): AsyncGenerator<ReturnType<typeof createChatCompletionChunk>> {
  yield* chunks
}

describe("updateFastifyWithChatRoute", () => {
  it("responds with the missing-conversation problem before storing a turn or contacting the model", async () => {
    const testApp = await createChatRouteTestApp()
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })
    const conversationId = createFixtureUuidV7(404)

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversation: { kind: "existing", id: conversationId }
    })

    expect(response.statusCode).toBe(404)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    const problem: unknown = response.json()
    expect(conversationNotFoundProblemSchema.safeParse(problem).success).toBe(
      true
    )
    expect(problem).toMatchObject({ instance: chatApi.path })
    expect(testApp.createConversationTurn).not.toHaveBeenCalled()
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
    expect(testApp.generateTitle).not.toHaveBeenCalled()
  })

  it("responds with a server error before contacting the model when the turn cannot be stored", async () => {
    const testApp = await createChatRouteTestApp()
    const storageFailure = new Error("database is locked")
    testApp.createConversationTurn.mockImplementation(() => {
      throw storageFailure
    })
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })

    const response = await sendChatRequest(
      testApp.app,
      NEW_CONVERSATION_REQUEST
    )

    expect(response.statusCode).toBe(500)
    expect(testApp.log.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({ message: storageFailure.message })
      })
    )
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
    expect(testApp.generateTitle).not.toHaveBeenCalled()
  })

  it.each([
    ["an empty message", { ...NEW_CONVERSATION_REQUEST, message: "" }],
    [
      "a conversation identifier that is not a UUIDv7",
      {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "existing", id: "conversation-1" }
      }
    ],
    [
      "an agent code that is not a valid code",
      {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "new", agentCode: "Caliginia" }
      }
    ],
    [
      "an agent code on a continued conversation",
      {
        ...NEW_CONVERSATION_REQUEST,
        conversation: {
          kind: "existing",
          id: createFixtureUuidV7(1),
          agentCode: "caliginia"
        }
      }
    ],
    [
      "an unknown conversation kind",
      { ...NEW_CONVERSATION_REQUEST, conversation: { kind: "draft" } }
    ],
    [
      "no conversation",
      {
        message: "Plan my trip",
        model: "qwen/qwen3-8b",
        generationOptions: { temperature: 0.4 }
      }
    ],
    [
      "a top-level conversation identifier instead of a conversation",
      {
        conversationId: createFixtureUuidV7(1),
        message: "Plan my trip",
        model: "qwen/qwen3-8b",
        generationOptions: { temperature: 0.4 }
      }
    ],
    [
      "missing generation options",
      {
        conversation: { kind: "new", agentCode: "caliginia" },
        message: "Plan my trip",
        model: "qwen/qwen3-8b"
      }
    ],
    ["an unknown field", { ...NEW_CONVERSATION_REQUEST, stream: true }],
    [
      "a tool offer without tools",
      { ...NEW_CONVERSATION_REQUEST, tools: { definitions: [] } }
    ],
    [
      "a tool offer that names one tool twice",
      {
        ...NEW_CONVERSATION_REQUEST,
        tools: { definitions: [READ_TEXT_FILE_TOOL, READ_TEXT_FILE_TOOL] }
      }
    ],
    [
      "a tool offer with empty client and backend tools",
      {
        ...NEW_CONVERSATION_REQUEST,
        tools: { definitions: [], backendToolNames: [] }
      }
    ],
    [
      "a client tool definition that the backend runs",
      {
        ...NEW_CONVERSATION_REQUEST,
        tools: { definitions: [{ ...READ_TEXT_FILE_TOOL, runner: "backend" }] }
      }
    ],
    [
      "a backend tool named twice",
      {
        ...NEW_CONVERSATION_REQUEST,
        tools: {
          definitions: [],
          backendToolNames: ["look_up_word", "look_up_word"]
        }
      }
    ],
    [
      "one name offered as both a client and a backend tool",
      {
        ...NEW_CONVERSATION_REQUEST,
        tools: {
          definitions: [READ_TEXT_FILE_TOOL],
          backendToolNames: ["read_text_file"]
        }
      }
    ],
    [
      "a backend tool name that is not a tool name",
      {
        ...NEW_CONVERSATION_REQUEST,
        tools: { definitions: [], backendToolNames: ["Look Up"] }
      }
    ],
    [
      "an empty attachment list",
      { ...NEW_CONVERSATION_REQUEST, attachments: [] }
    ],
    [
      "nine attachments",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: Array.from({ length: 9 }, (_, index) =>
          buildTextAttachmentPayload(`file-${index + 1}.txt`, "x")
        )
      }
    ],
    [
      "two attachments whose names differ only in case",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [
          buildTextAttachmentPayload("Notes.md", "a"),
          buildTextAttachmentPayload("notes.MD", "b")
        ]
      }
    ],
    [
      "two attachments whose names differ only in accent composition",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [
          buildTextAttachmentPayload("caf\u00e9.md", "a"),
          buildTextAttachmentPayload("cafe\u0301.md", "b")
        ]
      }
    ],
    [
      "two attachments whose names differ only in a letter that folds to two",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [
          buildTextAttachmentPayload("Stra\u00dfe.md", "a"),
          buildTextAttachmentPayload("STRASSE.md", "b")
        ]
      }
    ],
    [
      "an attachment whose name holds a slash",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [buildTextAttachmentPayload("notes/../x.md", "a")]
      }
    ],
    [
      "an attachment whose name holds a control character",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [buildTextAttachmentPayload("notes\u0007.md", "a")]
      }
    ],
    [
      "an attachment whose name is 128 characters of 2 bytes each, past the 255-byte limit",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [buildTextAttachmentPayload("\u00e9".repeat(128), "a")]
      }
    ],
    [
      "an attachment whose content is not base64",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [{ name: "notes.md", content: "not base64!" }]
      }
    ],
    [
      "a text attachment one byte larger than the per-file limit",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [
          buildSizedTextAttachmentPayload(
            "big.txt",
            MAXIMUM_ATTACHMENT_BYTES + 1
          )
        ]
      }
    ],
    [
      "text attachments that together pass the per-message limit by one byte",
      {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [
          buildSizedTextAttachmentPayload("one.txt", MAXIMUM_ATTACHMENT_BYTES),
          buildSizedTextAttachmentPayload("two.txt", MAXIMUM_ATTACHMENT_BYTES),
          buildSizedTextAttachmentPayload("three.txt", 1)
        ]
      }
    ]
  ])("rejects %s before storing a turn", async (_label, payload) => {
    const testApp = await createChatRouteTestApp()
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })

    const response = await sendChatRequest(testApp.app, payload)

    expect(response.statusCode).toBe(400)
    expect(testApp.createConversationTurn).not.toHaveBeenCalled()
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
    expect(testApp.generateTitle).not.toHaveBeenCalled()
  })

  it.each(["web-researcher", "lys"])(
    "responds with the missing-agent problem before storing a turn when a new conversation names the code %s, which no agent has",
    async (agentCode) => {
      const testApp = await createChatRouteTestApp()
      updateFastifyWithChatRoute(testApp.app, {
        ...CHAT_ROUTE_OPTIONS,
        generations: testApp.generations
      })

      const response = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "new", agentCode }
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(agentNotFoundProblemSchema.parse(response.json())).toMatchObject({
        detail: `Agent ${agentCode} was not found.`,
        instance: chatApi.path
      })
      expect(testApp.createConversationTurn).not.toHaveBeenCalled()
      expect(testApp.completeChatStream).not.toHaveBeenCalled()
      expect(testApp.generateTitle).not.toHaveBeenCalled()
    }
  )

  it.each(["caliginia", "lysiptera"] as const)(
    "has the built-in agent %s answer with her own system prompt and streams the stored reply",
    async (agentCode) => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)

      const response = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "new", agentCode }
      })

      expect(response.statusCode).toBe(200)
      expect(parseSseEvents(response.body)[0]).toMatchObject({
        event: "start-new-conversation-turn",
        data: { conversation: { agentCode } }
      })
      expect(testApp.completeChatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "system", content: TEST_BUILT_IN_AGENT_PROMPTS[agentCode] },
            { role: "user", content: NEW_CONVERSATION_REQUEST.message }
          ],
          model: NEW_CONVERSATION_REQUEST.model
        })
      )
      const replyEvents = parseSseEvents(response.body).filter(
        ({ event }) => event === "reply-part" || event === "done"
      )
      expect(replyEvents).toEqual([
        {
          event: "reply-part",
          data: {
            type: "reply-part",
            part: expect.objectContaining({
              kind: "text",
              round: 0,
              content: "Hi"
            })
          }
        },
        { event: "done", data: { type: "done", finishReason: "stop" } }
      ])
    }
  )

  it("does not ask for a new conversation's title while the model is not loaded, so neither request can load it", async () => {
    const testApp = await createChatRouteTestApp()
    registerStoringChatRoute(testApp)
    testApp.findLlmContextMeasurement.mockResolvedValue(undefined)

    const response = await sendChatRequest(
      testApp.app,
      NEW_CONVERSATION_REQUEST
    )

    expect(response.statusCode).toBe(200)
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
    expect(testApp.generateTitle).not.toHaveBeenCalled()
    expect(testApp.findLlmContextMeasurement).toHaveBeenCalledWith(
      NEW_CONVERSATION_REQUEST.model,
      []
    )
    expect(
      parseSseEvents(response.body).map(({ event }) => event)
    ).not.toContain("title")
    expect(testApp.log.records).toContainEqual(
      expect.objectContaining({
        level: "debug",
        titleGenerationOutcome: "model-not-loaded",
        titleGenerationAttempts: 0
      })
    )
  })

  it("has a stored agent answer a new conversation with its stored system prompt", async () => {
    const testApp = await createChatRouteTestApp()
    registerStoringChatRoute(testApp)

    const conversationId = await startWebResearcherConversation(testApp)

    expect(
      testApp.app.conversationHistoryReader.getConversation(conversationId)
    ).toMatchObject({ agentCode: "web-researcher" })
    expect(testApp.completeChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "You research the web." },
          { role: "user", content: WEB_RESEARCHER_REQUEST.message }
        ]
      })
    )
  })

  it("sends a stored agent's changed system prompt on the conversation's next turn", async () => {
    const testApp = await createChatRouteTestApp()
    registerStoringChatRoute(testApp)
    const conversationId = await startWebResearcherConversation(testApp)
    testApp.app.agentService.updateAgent("web-researcher", {
      systemPrompt: "You cite every source."
    })

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversation: { kind: "existing", id: conversationId },
      message: "And the budget?"
    })

    expect(response.statusCode).toBe(200)
    expect(testApp.completeChatStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "You cite every source." },
          { role: "user", content: WEB_RESEARCHER_REQUEST.message },
          { role: "assistant", content: "Hi" },
          { role: "user", content: "And the budget?" }
        ]
      })
    )
  })

  it("refuses a turn in a conversation whose agent was deleted, storing nothing and contacting no model", async () => {
    const testApp = await createChatRouteTestApp()
    registerStoringChatRoute(testApp)
    const conversationId = await startWebResearcherConversation(testApp)
    const history = testApp.app.conversationHistoryReader
    const storedConversation = history.getConversation(conversationId)
    testApp.app.agentService.deleteAgent("web-researcher")
    testApp.completeChatStream.mockClear()
    testApp.generateTitle.mockClear()

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversation: { kind: "existing", id: conversationId },
      message: "And the budget?"
    })

    expect(response.statusCode).toBe(409)
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/
    )
    expect(
      conversationAgentMissingProblemSchema.parse(response.json())
    ).toMatchObject({
      detail:
        "The agent web-researcher that answers this conversation no longer exists.",
      instance: chatApi.path
    })
    expect(storedConversation?.messages).toHaveLength(2)
    expect(history.getConversation(conversationId)).toEqual(storedConversation)
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
    expect(testApp.generateTitle).not.toHaveBeenCalled()
  })

  it("answers a conversation again once an agent is stored under its deleted agent's code", async () => {
    const testApp = await createChatRouteTestApp()
    registerStoringChatRoute(testApp)
    const conversationId = await startWebResearcherConversation(testApp)
    testApp.app.agentService.deleteAgent("web-researcher")
    testApp.app.agentService.createAgent({
      ...WEB_RESEARCHER_DEFINITION,
      systemPrompt: "You are the second researcher."
    })

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversation: { kind: "existing", id: conversationId },
      message: "And the budget?"
    })

    expect(response.statusCode).toBe(200)
    expect(testApp.completeChatStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: "system", content: "You are the second researcher." }
        ])
      })
    )
  })

  it("rejects a backend tool the backend does not run before storing a turn, naming it", async () => {
    const testApp = await createChatRouteTestApp()
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      tools: {
        definitions: [],
        backendToolNames: ["look_up_word", "fetch_url"]
      }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      message:
        "The request offers backend tools the backend does not run: fetch_url"
    })
    expect(testApp.createConversationTurn).not.toHaveBeenCalled()
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
  })

  it("refuses a backend tool that cannot run now before storing a turn, naming it and why", async () => {
    const testApp = await createChatRouteTestApp()
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      tools: {
        definitions: [],
        backendToolNames: ["look_up_word", "check_spelling"]
      }
    })

    expect(response.statusCode).toBe(409)
    expect(response.headers["content-type"]).toContain(
      "application/problem+json"
    )
    expect(response.json()).toEqual({
      type: "urn:lys:problem:chat:backend-tool-unavailable",
      title: "Backend tool unavailable",
      status: 409,
      detail: "check_spelling is unavailable: no Tavily API key is saved.",
      instance: "/api/v1/chat",
      toolName: "check_spelling",
      reason: "api-key-missing"
    })
    expect(
      chatBackendToolUnavailableProblemSchema.safeParse(response.json()).success
    ).toBe(true)
    expect(testApp.createConversationTurn).not.toHaveBeenCalled()
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
  })

  it("still refuses an unknown backend tool before looking any up", async () => {
    const testApp = await createChatRouteTestApp()
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      tools: {
        definitions: [],
        backendToolNames: ["check_spelling", "fetch_url"]
      }
    })

    expect(response.statusCode).toBe(400)
  })

  it.each([
    [
      "offers the request's client tools to the model",
      { definitions: [READ_TEXT_FILE_TOOL] },
      [READ_TEXT_FILE_FORMAT]
    ],
    [
      "offers the request's backend tools after its client tools",
      {
        definitions: [READ_TEXT_FILE_TOOL],
        backendToolNames: ["look_up_word"]
      },
      [READ_TEXT_FILE_FORMAT, LOOK_UP_WORD_FORMAT]
    ],
    [
      "offers only backend tools when the request offers no client tool",
      { definitions: [], backendToolNames: ["look_up_word"] },
      [LOOK_UP_WORD_FORMAT]
    ],
    ["offers no tools when the request offers none", undefined, []]
  ] as const)("%s", async (_label, tools, offeredTools) => {
    const testApp = await createChatRouteTestApp()
    testApp.createConversationTurn.mockRestore()
    testApp.completeChatStream.mockImplementation(async () =>
      (async function* () {
        yield createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
      })()
    )
    testApp.generateTitle.mockResolvedValue("Trip plan")
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })

    await sendChatRequest(
      testApp.app,
      tools === undefined
        ? NEW_CONVERSATION_REQUEST
        : { ...NEW_CONVERSATION_REQUEST, tools }
    )

    expect(testApp.completeChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ tools: offeredTools })
    )
  })

  it.each([
    [
      "an error-level failure",
      new Error("model not loaded"),
      "error",
      "Chat completion stream failed"
    ],
    [
      "a debug-level cancellation",
      new ChatCompletionCancelledError(new Error("aborted")),
      "debug",
      "Chat completion was cancelled"
    ]
  ])(
    "logs a reply ended by the model's rejection as %s with the request's logger",
    async (_label, rejection, level, msg) => {
      const testApp = await createChatRouteTestApp()
      // Store the turn for real, so the reply's writes reach a stored message.
      testApp.createConversationTurn.mockRestore()
      testApp.completeChatStream.mockRejectedValue(rejection)
      testApp.generateTitle.mockResolvedValue("Trip plan")
      updateFastifyWithChatRoute(testApp.app, {
        ...CHAT_ROUTE_OPTIONS,
        generations: testApp.generations
      })

      const response = await sendChatRequest(
        testApp.app,
        NEW_CONVERSATION_REQUEST
      )

      expect(response.statusCode).toBe(200)
      expect(testApp.log.records).toContainEqual(
        expect.objectContaining({
          level,
          msg,
          reqId: expect.any(String),
          // Pino appends the messages of the failure's causes.
          err: expect.objectContaining({
            message: expect.stringContaining(rejection.message)
          })
        })
      )
    }
  )

  it("logs a round that was not sent because the model is not loaded at debug level, not as a failure", async () => {
    const testApp = await createChatRouteTestApp()
    registerStoringChatRoute(testApp)
    testApp.findLlmContextMeasurement.mockResolvedValue(undefined)

    const response = await sendChatRequest(
      testApp.app,
      NEW_CONVERSATION_REQUEST
    )

    expect(response.statusCode).toBe(200)
    expect(testApp.log.records).toContainEqual(
      expect.objectContaining({
        level: "debug",
        msg: "Chat round was not sent to the model",
        reqId: expect.any(String),
        err: expect.objectContaining({
          message: `The model "${NEW_CONVERSATION_REQUEST.model}" is not loaded`
        })
      })
    )
    expect(testApp.log.records).not.toContainEqual(
      expect.objectContaining({ level: "error" })
    )
  })

  describe("tool call approval", () => {
    /** Request whose turn offers the scripted backend look-up tool. */
    const LOOK_UP_REQUEST = Object.freeze({
      ...NEW_CONVERSATION_REQUEST,
      tools: { definitions: [], backendToolNames: ["look_up_word"] }
    })

    /**
     * Registers the chat route on a test application whose model looks up
     * `moth` in its first round and answers `Done` in its second.
     *
     * @returns The application and the generation the route starts, once
     * started.
     */
    async function createLookUpApp() {
      const testApp = await createChatRouteTestApp()
      testApp.createConversationTurn.mockRestore()
      testApp.completeChatStream
        .mockImplementationOnce(async () =>
          (async function* () {
            yield createChatCompletionChunk({
              toolCalls: [
                {
                  index: 0,
                  id: "call_0",
                  type: "function",
                  function: {
                    name: "look_up_word",
                    arguments: '{"word":"moth"}'
                  }
                }
              ]
            })
            yield createChatCompletionChunk({ finishReason: "tool_calls" })
          })()
        )
        .mockImplementationOnce(async () =>
          (async function* () {
            yield createChatCompletionChunk({
              content: "Done",
              finishReason: "stop"
            })
          })()
        )
      testApp.generateTitle.mockResolvedValue("Trip plan")
      const startReplyGeneration = vi.spyOn(
        testApp.generations,
        "startReplyGeneration"
      )
      updateFastifyWithChatRoute(testApp.app, {
        ...CHAT_ROUTE_OPTIONS,
        generations: testApp.generations
      })

      /**
       * Gets the generation the route started.
       *
       * @returns The generation.
       * @throws If the route has not started one.
       */
      function getGeneration(): ReplyGeneration {
        const result = startReplyGeneration.mock.results[0]
        if (result?.type !== "return") throw new Error("No generation started.")
        return result.value
      }

      return { testApp, getGeneration }
    }

    it("asks the person before a call of a tool on Ask me runs, and runs it once allowed", async () => {
      const { testApp, getGeneration } = await createLookUpApp()
      testApp.readJustRunToolNames.mockResolvedValue({
        status: "read",
        toolNames: new Set()
      })

      const responsePromise = sendChatRequest(testApp.app, LOOK_UP_REQUEST)
      await vi.waitFor(() => {
        expect(getGeneration().pendingToolCalls.toolApprovals).toHaveLength(1)
      })
      const [prompt] = getGeneration().pendingToolCalls.toolApprovals
      if (prompt === undefined) throw new Error("No prompt was sent.")
      expect(testApp.completeChatStream).toHaveBeenCalledOnce()
      getGeneration().resolveToolCall(prompt.id, { status: "allowed" })
      const response = await responsePromise

      const events = parseSseEvents(response.body)
      expect(events).toContainEqual({
        event: "tool-approval",
        data: { type: "tool-approval", call: prompt }
      })
      expect(prompt).toMatchObject({
        toolName: "look_up_word",
        arguments: { word: "moth" }
      })
      expect(testApp.completeChatStream).toHaveBeenCalledTimes(2)
      expect(events.at(-1)?.event).toBe("done")
    })

    it("runs a call of a tool saved as Just run without asking the person", async () => {
      const { testApp } = await createLookUpApp()
      testApp.readJustRunToolNames.mockResolvedValue({
        status: "read",
        toolNames: new Set(["look_up_word"])
      })

      const response = await sendChatRequest(testApp.app, LOOK_UP_REQUEST)

      const eventTypes = parseSseEvents(response.body).map(
        (event) => event.event
      )
      expect(eventTypes).not.toContain("tool-approval")
      expect(eventTypes.at(-1)).toBe("done")
      expect(testApp.readJustRunToolNames).toHaveBeenCalledOnce()
    })

    it("asks the person and logs a warning with the request's logger when the saved choices cannot be read", async () => {
      const { testApp, getGeneration } = await createLookUpApp()
      testApp.readJustRunToolNames.mockResolvedValue({ status: "unreadable" })

      const responsePromise = sendChatRequest(testApp.app, LOOK_UP_REQUEST)
      await vi.waitFor(() => {
        expect(getGeneration().pendingToolCalls.toolApprovals).toHaveLength(1)
      })
      const [prompt] = getGeneration().pendingToolCalls.toolApprovals
      if (prompt === undefined) throw new Error("No prompt was sent.")
      getGeneration().resolveToolCall(prompt.id, {
        status: "rejected",
        reason: "declined",
        content: "The person declined this call."
      })
      await responsePromise

      expect(testApp.log.records).toContainEqual(
        expect.objectContaining({
          level: "warn",
          reqId: expect.any(String),
          msg: expect.stringContaining("Just run")
        })
      )
    })
  })

  describe("web sources", () => {
    /** Tools each turn of these cases offers: the backend look-up tool. */
    const LOOK_UP_TOOLS = Object.freeze({
      definitions: [],
      backendToolNames: ["look_up_word"]
    })

    /**
     * Adds the model streams of one turn that looks up a word, then says
     * `Done`.
     *
     * @param testApp - Test application whose model the turn uses.
     * @param word - Word the model looks up.
     */
    function addLookUpTurnStreams(
      testApp: ChatRouteTestApp,
      word: string
    ): void {
      const callChunk = createChatCompletionChunk({
        toolCalls: [
          {
            index: 0,
            id: "call_0",
            type: "function",
            function: {
              name: "look_up_word",
              arguments: JSON.stringify({ word })
            }
          }
        ]
      })
      testApp.completeChatStream
        .mockImplementationOnce(async () =>
          createChunkStream(
            callChunk,
            createChatCompletionChunk({ finishReason: "tool_calls" })
          )
        )
        .mockImplementationOnce(async () =>
          createChunkStream(
            createChatCompletionChunk({
              content: "Done [1]",
              finishReason: "stop"
            })
          )
        )
    }

    /**
     * Registers the chat route on a test application whose turns are stored
     * for real and whose look-up tool is saved as Just run.
     *
     * @returns The test application.
     */
    async function createSourceNumberingApp(): Promise<ChatRouteTestApp> {
      const testApp = await createChatRouteTestApp()
      testApp.createConversationTurn.mockRestore()
      testApp.generateTitle.mockResolvedValue("Moths")
      testApp.readJustRunToolNames.mockResolvedValue({
        status: "read",
        toolNames: new Set(["look_up_word"])
      })
      updateFastifyWithChatRoute(testApp.app, {
        ...CHAT_ROUTE_OPTIONS,
        generations: testApp.generations
      })
      return testApp
    }

    /**
     * Sends one turn whose model looks up a word, then says `Done [1]`.
     *
     * @param testApp - Test application from
     * {@link createSourceNumberingApp}.
     * @param word - Word the model looks up.
     * @param conversation - Conversation the turn starts or adds to.
     * @returns The turn's finished response.
     */
    async function sendLookUpTurn(
      testApp: ChatRouteTestApp,
      word: string,
      conversation: Readonly<Record<string, unknown>>
    ): Promise<LightMyRequestResponse> {
      addLookUpTurnStreams(testApp, word)
      return await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation,
        message: `What is a ${word}?`,
        tools: LOOK_UP_TOOLS
      })
    }

    it("numbers a later turn's new sources after the ones the conversation stored, keeping a known URL's number", async () => {
      const testApp = await createSourceNumberingApp()
      const first = await sendLookUpTurn(
        testApp,
        "moth",
        NEW_CONVERSATION_REQUEST.conversation
      )
      const start = chatApiStreamEventSchema.parse(
        parseSseEvents(first.body)[0]?.data
      )
      if (start.type !== "start-new-conversation-turn")
        throw new Error("The chat route did not start a new conversation")
      const conversation = { kind: "existing", id: start.conversation.id }

      const second = await sendLookUpTurn(testApp, "lamp", conversation)
      const third = await sendLookUpTurn(testApp, "moth", conversation)

      const moth = {
        number: 1,
        url: "https://words.example/moth",
        title: "Dictionary: moth"
      }
      const lamp = {
        number: 2,
        url: "https://words.example/lamp",
        title: "Dictionary: lamp"
      }
      for (const [response, sources] of [
        [first, [moth]],
        [second, [lamp]],
        [third, [moth]]
      ] as const)
        expect(parseSseEvents(response.body)).toContainEqual({
          event: "sources",
          data: { type: "sources", sources }
        })
      expect(
        testApp.app.conversationHistoryReader.getConversation(
          start.conversation.id
        )?.sources
      ).toEqual([moth, lamp])
    })
  })

  describe("attachments", () => {
    /** The request model as the inventory lists a text-only model that uses tools. */
    const TEXT_MODEL_INFO: LlmInfo = Object.freeze({
      ...createDownloadedLlmModel({ modelKey: NEW_CONVERSATION_REQUEST.model }),
      vision: false,
      trainedForToolUse: true,
      loaded: true
    })

    /** The request model as the inventory lists a model that sees images. */
    const VISION_MODEL_INFO: LlmInfo = Object.freeze({
      ...TEXT_MODEL_INFO,
      vision: true
    })

    /** Text of the notes file: two lines, 18 bytes. */
    const NOTES_TEXT = "Buy milk\nCall mum\n"

    /** The notes file as a request carries it. */
    const NOTES_ATTACHMENT = Object.freeze({
      name: "notes.md",
      content: buildAttachmentContent(new TextEncoder().encode(NOTES_TEXT))
    })

    /** A 64 by 32 PNG as a request carries it. */
    const PHOTO_ATTACHMENT = Object.freeze({
      name: "photo.png",
      content: buildAttachmentContent(createPngBytes(64, 32))
    })

    /** Request starting a conversation with the notes file attached. */
    const NOTES_REQUEST = Object.freeze({
      ...NEW_CONVERSATION_REQUEST,
      attachments: [NOTES_ATTACHMENT]
    })

    /** Request starting a conversation with the photo attached. */
    const PHOTO_REQUEST = Object.freeze({
      ...NEW_CONVERSATION_REQUEST,
      attachments: [PHOTO_ATTACHMENT]
    })

    /** The user message's text as the model reads it with the notes file. */
    const NOTES_MESSAGE_TEXT =
      "Plan my trip\n\nAttached files:\n[attachment 1] notes.md (text, 18 bytes)"

    /**
     * Lists every file under the test application's attachments directory.
     *
     * @param testApp - Test application.
     * @returns Each file's path relative to the directory, sorted.
     */
    function listStoredFiles(testApp: ChatRouteTestApp): readonly string[] {
      const root = testApp.attachmentsDirectoryPath
      return readdirSync(root, { recursive: true })
        .map(String)
        .filter((path) => statSync(join(root, path)).isFile())
        .sort()
    }

    /**
     * Reads the start event of a chat response.
     *
     * @param response - Completed chat response.
     * @returns The start event of a new conversation's turn.
     * @throws If the response did not start a new conversation.
     */
    function readNewConversationStart(response: LightMyRequestResponse) {
      const start = chatApiStreamEventSchema.parse(
        parseSseEvents(response.body)[0]?.data
      )
      if (start.type !== "start-new-conversation-turn")
        throw new Error("The chat route did not start a new conversation")
      return start
    }

    /**
     * Lists the names of the tools a chat completion call offered.
     *
     * @param testApp - Test application.
     * @param callIndex - Index of the chat completion call.
     * @returns The offered tool names in offer order.
     */
    function listOfferedToolNames(
      testApp: ChatRouteTestApp,
      callIndex: number
    ): readonly string[] {
      return (
        testApp.completeChatStream.mock.calls[callIndex]?.[0].tools ?? []
      ).map((tool) => tool.function.name)
    }

    /**
     * Arranges a model that reads attachment 1 in its first round and
     * answers `Hi` in its second.
     *
     * @param testApp - Test application registered by
     * {@link registerStoringChatRoute}.
     */
    function arrangeAttachmentReadingModel(testApp: ChatRouteTestApp): void {
      testApp.completeChatStream.mockImplementationOnce(async () =>
        createChunkStream(
          createChatCompletionChunk({
            toolCalls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "read_attachment", arguments: '{"number":1}' }
              }
            ]
          }),
          createChatCompletionChunk({ finishReason: "tool_calls" })
        )
      )
    }

    it("refuses an attachment whose content is neither text nor an image Lys sends, before reading the inventory or storing anything", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)

      const response = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [
          NOTES_ATTACHMENT,
          {
            name: "clip.gif",
            content: buildAttachmentContent(
              new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00])
            )
          }
        ]
      })

      expect(response.statusCode).toBe(400)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(
        chatAttachmentUnsupportedProblemSchema.parse(response.json())
      ).toMatchObject({ fileName: "clip.gif", instance: chatApi.path })
      expect(testApp.listLlmModels).not.toHaveBeenCalled()
      expect(testApp.completeChatStream).not.toHaveBeenCalled()
      expect(listStoredFiles(testApp)).toEqual([])
      expect(
        testApp.app.conversationHistoryReader.listConversations({
          query: "",
          cursor: undefined,
          limit: 30
        }).storedCount
      ).toBe(0)
    })

    it.each([
      [
        "a client tool",
        { definitions: [{ ...READ_TEXT_FILE_TOOL, name: "read_attachment" }] }
      ],
      [
        "a backend tool",
        { definitions: [], backendToolNames: ["read_attachment"] }
      ]
    ])(
      "refuses a request that offers the attachment reader's name as %s, saying the backend adds the reader itself",
      async (_label, tools) => {
        const testApp = await createChatRouteTestApp()
        registerStoringChatRoute(testApp)

        const response = await sendChatRequest(testApp.app, {
          ...NOTES_REQUEST,
          tools
        })

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({
          message: expect.stringContaining(
            "A request does not offer read_attachment; the backend adds it to a turn itself."
          )
        })
        expect(testApp.listLlmModels).not.toHaveBeenCalled()
        expect(testApp.completeChatStream).not.toHaveBeenCalled()
        expect(readdirSync(testApp.attachmentsDirectoryPath)).toEqual([])
      }
    )

    it.each([
      [
        "one byte over the per-file limit",
        [
          buildSizedTextAttachmentPayload(
            "big.txt",
            MAXIMUM_ATTACHMENT_BYTES + 1
          )
        ],
        `An attachment has at most ${MAXIMUM_ATTACHMENT_BYTES} bytes.`
      ],
      [
        "one byte over the per-message limit together",
        [
          buildSizedTextAttachmentPayload("one.txt", MAXIMUM_ATTACHMENT_BYTES),
          buildSizedTextAttachmentPayload("two.txt", MAXIMUM_ATTACHMENT_BYTES),
          buildSizedTextAttachmentPayload("three.txt", 1)
        ],
        `A message's attachments have at most ${MAXIMUM_MESSAGE_ATTACHMENT_BYTES} bytes together.`
      ]
    ])(
      "refuses text attachments %s, saying so, before reading the inventory or storing anything",
      async (_label, attachments, message) => {
        const testApp = await createChatRouteTestApp()
        registerStoringChatRoute(testApp)

        const response = await sendChatRequest(testApp.app, {
          ...NEW_CONVERSATION_REQUEST,
          attachments
        })

        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({
          message: expect.stringContaining(message)
        })
        expect(testApp.listLlmModels).not.toHaveBeenCalled()
        expect(testApp.completeChatStream).not.toHaveBeenCalled()
        expect(readdirSync(testApp.attachmentsDirectoryPath)).toEqual([])
      }
    )

    it("stores a text attachment of exactly the per-file limit", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      testApp.listLlmModels.mockResolvedValue([TEXT_MODEL_INFO])

      const response = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [
          buildSizedTextAttachmentPayload("full.txt", MAXIMUM_ATTACHMENT_BYTES)
        ]
      })

      expect(response.statusCode).toBe(200)
      const start = readNewConversationStart(response)
      expect(start.userMessage.attachments).toEqual([
        {
          kind: "text",
          number: 1,
          name: "full.txt",
          sizeBytes: MAXIMUM_ATTACHMENT_BYTES
        }
      ])
      const [filePath] = listStoredFiles(testApp)
      expect(filePath).toMatch(/\/full\.txt$/)
      expect(
        statSync(join(testApp.attachmentsDirectoryPath, filePath ?? "")).size
      ).toBe(MAXIMUM_ATTACHMENT_BYTES)
    })

    it("refuses a body over the chat route's limit with a 413, before reading the inventory or storing anything", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)

      const response = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        attachments: [
          { name: "huge.txt", content: "A".repeat(chatApi.bodyLimitBytes) }
        ]
      })

      expect(response.statusCode).toBe(413)
      expect(testApp.listLlmModels).not.toHaveBeenCalled()
      expect(testApp.completeChatStream).not.toHaveBeenCalled()
      expect(readdirSync(testApp.attachmentsDirectoryPath)).toEqual([])
    })

    it.each([
      ["a model that cannot see images", [TEXT_MODEL_INFO]],
      ["a model the inventory does not list", []]
    ])(
      "refuses an image for %s, naming the image and the model, and stores nothing",
      async (_label, inventory) => {
        const testApp = await createChatRouteTestApp()
        registerStoringChatRoute(testApp)
        testApp.listLlmModels.mockResolvedValue(inventory)

        const response = await sendChatRequest(testApp.app, {
          ...NEW_CONVERSATION_REQUEST,
          attachments: [NOTES_ATTACHMENT, PHOTO_ATTACHMENT]
        })

        expect(response.statusCode).toBe(409)
        expect(response.headers["content-type"]).toMatch(
          /^application\/problem\+json/
        )
        expect(
          chatImageNeedsVisionProblemSchema.parse(response.json())
        ).toMatchObject({
          fileName: "photo.png",
          model: NEW_CONVERSATION_REQUEST.model,
          instance: chatApi.path
        })
        expect(testApp.completeChatStream).not.toHaveBeenCalled()
        expect(listStoredFiles(testApp)).toEqual([])
      }
    )

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
      "responds with its 503 problem for %s met while the model's capabilities are read, storing nothing",
      async (_label, failure, problemType) => {
        const testApp = await createChatRouteTestApp()
        registerStoringChatRoute(testApp)
        testApp.listLlmModels.mockRejectedValue(failure)

        const response = await sendChatRequest(testApp.app, NOTES_REQUEST)

        expect(response.statusCode).toBe(503)
        expect(response.json()).toMatchObject({
          type: problemType,
          status: 503
        })
        expect(testApp.completeChatStream).not.toHaveBeenCalled()
        expect(listStoredFiles(testApp)).toEqual([])
      }
    )

    it("does not read the inventory, and creates no folder, for a turn without attachments in a conversation without any", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)

      const response = await sendChatRequest(
        testApp.app,
        NEW_CONVERSATION_REQUEST
      )

      expect(response.statusCode).toBe(200)
      expect(testApp.listLlmModels).not.toHaveBeenCalled()
      expect(listOfferedToolNames(testApp, 0)).toEqual([])
      expect(readdirSync(testApp.attachmentsDirectoryPath)).toEqual([])
    })

    it("refuses a turn whose conversation was deleted while the inventory was read, and leaves no file of it", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      testApp.listLlmModels.mockResolvedValue([TEXT_MODEL_INFO])
      const first = await sendChatRequest(testApp.app, NOTES_REQUEST)
      const conversationId = readNewConversationStart(first).conversation.id
      testApp.listLlmModels.mockImplementationOnce(async () => {
        testApp.app.conversationHistoryEditor.deleteConversation(conversationId)
        return [TEXT_MODEL_INFO]
      })

      const second = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "existing", id: conversationId },
        message: "One more",
        attachments: [buildTextAttachmentPayload("plan.txt", "Go")]
      })

      expect(second.statusCode).toBe(404)
      expect(
        conversationNotFoundProblemSchema.safeParse(second.json()).success
      ).toBe(true)
      expect(readdirSync(testApp.attachmentsDirectoryPath)).toEqual([])
      expect(testApp.completeChatStream).toHaveBeenCalledTimes(1)
    })

    it("refuses a turn whose agent was deleted while the inventory was read, keeping the conversation's other files", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      testApp.listLlmModels.mockResolvedValue([TEXT_MODEL_INFO])
      testApp.app.agentService.createAgent(WEB_RESEARCHER_DEFINITION)
      const first = await sendChatRequest(testApp.app, {
        ...WEB_RESEARCHER_REQUEST,
        attachments: [NOTES_ATTACHMENT]
      })
      const conversationId = readNewConversationStart(first).conversation.id
      const storedFiles = listStoredFiles(testApp)
      testApp.listLlmModels.mockImplementationOnce(async () => {
        testApp.app.agentService.deleteAgent(WEB_RESEARCHER_DEFINITION.code)
        return [TEXT_MODEL_INFO]
      })

      const second = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "existing", id: conversationId },
        message: "One more",
        attachments: [buildTextAttachmentPayload("plan.txt", "Go")]
      })

      expect(second.statusCode).toBe(409)
      expect(
        conversationAgentMissingProblemSchema.safeParse(second.json()).success
      ).toBe(true)
      expect(storedFiles).toHaveLength(1)
      expect(listStoredFiles(testApp)).toEqual(storedFiles)
      expect(
        testApp.app.conversationHistoryReader.getConversation(conversationId)
          ?.messages
      ).toHaveLength(2)
      expect(testApp.completeChatStream).toHaveBeenCalledTimes(1)
    })

    it("sends an image a model saw as a sentence to a later turn's model that cannot see images", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      const textOnlyModel = "qwen/qwen3-8b-text"
      testApp.listLlmModels.mockResolvedValue([
        VISION_MODEL_INFO,
        { ...TEXT_MODEL_INFO, modelKey: textOnlyModel }
      ])

      const first = await sendChatRequest(testApp.app, PHOTO_REQUEST)
      const start = readNewConversationStart(first)
      const second = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "existing", id: start.conversation.id },
        message: "And now?",
        model: textOnlyModel
      })

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(
        testApp.completeChatStream.mock.calls[1]?.[0].messages.slice(1)
      ).toEqual([
        {
          role: "user",
          content:
            "Plan my trip\n\nAttached files:\n[attachment 1] photo.png (image/png, 64×32, 33 bytes)\n[attachment 1] photo.png is an image that this model cannot see."
        },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "And now?" }
      ])
    })

    it("stores a text file with the message, lists it for the model, and lets the model read it through the reader without asking the person", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      arrangeAttachmentReadingModel(testApp)
      testApp.listLlmModels.mockResolvedValue([TEXT_MODEL_INFO])
      testApp.readJustRunToolNames.mockResolvedValue({
        status: "read",
        toolNames: new Set()
      })

      const response = await sendChatRequest(testApp.app, NOTES_REQUEST)

      expect(response.statusCode).toBe(200)
      const start = readNewConversationStart(response)
      expect(start.userMessage.attachments).toEqual([
        { kind: "text", number: 1, name: "notes.md", sizeBytes: 18 }
      ])
      const filePath = join(
        start.conversation.id,
        start.userMessage.id,
        "notes.md"
      )
      expect(listStoredFiles(testApp)).toEqual([filePath])
      expect(
        readFileSync(join(testApp.attachmentsDirectoryPath, filePath), "utf8")
      ).toBe(NOTES_TEXT)
      expect(testApp.completeChatStream.mock.calls[0]?.[0].messages[1]).toEqual(
        { role: "user", content: NOTES_MESSAGE_TEXT }
      )
      expect(listOfferedToolNames(testApp, 0)).toEqual(["read_attachment"])
      expect(
        testApp.completeChatStream.mock.calls[1]?.[0].messages.at(-1)
      ).toEqual({
        role: "tool",
        tool_call_id: expect.any(String),
        content:
          "[attachment 1] notes.md, lines 1–2 of 2 (18 bytes).\nBuy milk\nCall mum"
      })
      const events = parseSseEvents(response.body)
      expect(events.map((event) => event.event)).not.toContain("tool-approval")
      expect(
        events.flatMap((event) =>
          event.event === "reply-part" &&
          typeof event.data === "object" &&
          event.data !== null &&
          "part" in event.data &&
          typeof event.data.part === "object" &&
          event.data.part !== null &&
          "status" in event.data.part
            ? [event.data.part.status]
            : []
        )
      ).toEqual(["running", "succeeded"])
      expect(events.at(-1)?.event).toBe("done")
      expect(
        testApp.app.conversationHistoryReader.getConversation(
          start.conversation.id
        )?.messages[0]
      ).toEqual(start.userMessage)
    })

    it("offers no reader to a model that is not trained for tool use, and still lists the file for it", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      testApp.listLlmModels.mockResolvedValue([
        { ...TEXT_MODEL_INFO, trainedForToolUse: false }
      ])

      const response = await sendChatRequest(testApp.app, NOTES_REQUEST)

      expect(response.statusCode).toBe(200)
      expect(listOfferedToolNames(testApp, 0)).toEqual([])
      expect(testApp.completeChatStream.mock.calls[0]?.[0].messages[1]).toEqual(
        { role: "user", content: NOTES_MESSAGE_TEXT }
      )
    })

    it("sends an image the model sees after the message's text, and sends it again on the conversation's next turn", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      testApp.listLlmModels.mockResolvedValue([VISION_MODEL_INFO])
      const imageMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: "Plan my trip\n\nAttached files:\n[attachment 1] photo.png (image/png, 64×32, 33 bytes)"
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${PHOTO_ATTACHMENT.content}`
            }
          }
        ]
      }

      const first = await sendChatRequest(testApp.app, PHOTO_REQUEST)
      const start = readNewConversationStart(first)
      const second = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "existing", id: start.conversation.id },
        message: "And now?"
      })

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(start.userMessage.attachments).toEqual([
        {
          kind: "image",
          number: 1,
          name: "photo.png",
          sizeBytes: 33,
          mediaType: "image/png",
          width: 64,
          height: 32
        }
      ])
      expect(testApp.completeChatStream.mock.calls[0]?.[0].messages[1]).toEqual(
        imageMessage
      )
      expect(listOfferedToolNames(testApp, 0)).toEqual([])
      expect(
        testApp.completeChatStream.mock.calls[1]?.[0].messages.slice(1)
      ).toEqual([
        imageMessage,
        { role: "assistant", content: "Hi" },
        { role: "user", content: "And now?" }
      ])
      expect(testApp.listLlmModels).toHaveBeenCalledTimes(2)
    })

    it("numbers a later turn's attachments after the conversation's, and offers the reader on a turn without new attachments", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      testApp.listLlmModels.mockResolvedValue([TEXT_MODEL_INFO])

      const first = await sendChatRequest(testApp.app, NOTES_REQUEST)
      const conversation = {
        kind: "existing",
        id: readNewConversationStart(first).conversation.id
      }
      const second = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation,
        message: "One more",
        attachments: [
          {
            name: "plan.txt",
            content: buildAttachmentContent(new TextEncoder().encode("Go"))
          }
        ]
      })
      const third = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation,
        message: "Read them"
      })

      expect(second.statusCode).toBe(200)
      expect(third.statusCode).toBe(200)
      const secondStart = chatApiStreamEventSchema.parse(
        parseSseEvents(second.body)[0]?.data
      )
      expect(secondStart).toMatchObject({
        type: "start-existing-conversation-turn",
        userMessage: {
          attachments: [
            { kind: "text", number: 2, name: "plan.txt", sizeBytes: 2 }
          ]
        }
      })
      expect(listOfferedToolNames(testApp, 2)).toEqual(["read_attachment"])
      expect(
        testApp.completeChatStream.mock.calls[2]?.[0].messages.at(-1)
      ).toEqual({ role: "user", content: "Read them" })
      expect(listStoredFiles(testApp)).toHaveLength(2)
      expect(testApp.listLlmModels).toHaveBeenCalledTimes(3)
    })

    it("deletes the written files and responds with a server error when the turn cannot be stored", async () => {
      const testApp = await createChatRouteTestApp()
      const storageFailure = new Error("database is locked")
      testApp.createConversationTurn.mockImplementation(() => {
        throw storageFailure
      })
      testApp.listLlmModels.mockResolvedValue([TEXT_MODEL_INFO])
      updateFastifyWithChatRoute(testApp.app, {
        ...CHAT_ROUTE_OPTIONS,
        generations: testApp.generations
      })

      const response = await sendChatRequest(testApp.app, NOTES_REQUEST)

      expect(response.statusCode).toBe(500)
      expect(readdirSync(testApp.attachmentsDirectoryPath)).toEqual([])
      expect(testApp.log.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          err: expect.objectContaining({ message: storageFailure.message })
        })
      )
      expect(testApp.completeChatStream).not.toHaveBeenCalled()
    })

    it("deletes only the message's files when a continued conversation's turn cannot be stored", async () => {
      const testApp = await createChatRouteTestApp()
      registerStoringChatRoute(testApp)
      testApp.listLlmModels.mockResolvedValue([TEXT_MODEL_INFO])
      const first = await sendChatRequest(testApp.app, NOTES_REQUEST)
      const conversationId = readNewConversationStart(first).conversation.id
      const storedFiles = listStoredFiles(testApp)
      vi.spyOn(
        testApp.app.conversationTurns,
        "createConversationTurn"
      ).mockImplementationOnce(() => {
        throw new Error("database is locked")
      })

      const second = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "existing", id: conversationId },
        message: "One more",
        attachments: [buildTextAttachmentPayload("plan.txt", "Go")]
      })

      expect(second.statusCode).toBe(500)
      expect(storedFiles).toHaveLength(1)
      expect(listStoredFiles(testApp)).toEqual(storedFiles)
      expect(
        readdirSync(join(testApp.attachmentsDirectoryPath, conversationId))
      ).toHaveLength(1)
    })

    it("responds with a server error holding both failures when the written files cannot be deleted after the turn cannot be stored", async () => {
      const testApp = await createChatRouteTestApp()
      const storageFailure = new Error("database is locked")
      const deletionFailure = new Error("EPERM: operation not permitted")
      testApp.createConversationTurn.mockImplementation(() => {
        throw storageFailure
      })
      vi.spyOn(
        testApp.app.attachmentFileStore,
        "deleteConversationAttachments"
      ).mockRejectedValue(deletionFailure)
      testApp.listLlmModels.mockResolvedValue([TEXT_MODEL_INFO])
      updateFastifyWithChatRoute(testApp.app, {
        ...CHAT_ROUTE_OPTIONS,
        generations: testApp.generations
      })

      const response = await sendChatRequest(testApp.app, NOTES_REQUEST)

      expect(response.statusCode).toBe(500)
      expect(listStoredFiles(testApp)).toEqual([
        expect.stringMatching(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/notes\.md$/)
      ])
      expect(testApp.log.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          err: expect.objectContaining({
            message: expect.stringContaining(
              "Attachment files could not be deleted after the turn failed to store"
            ),
            aggregateErrors: [
              expect.objectContaining({ message: storageFailure.message }),
              expect.objectContaining({ message: deletionFailure.message })
            ]
          })
        })
      )
      expect(testApp.completeChatStream).not.toHaveBeenCalled()
    })
  })
})
