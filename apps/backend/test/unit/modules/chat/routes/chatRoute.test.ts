import {
  agentNotFoundProblemSchema,
  chatApi,
  conversationNotFoundProblemSchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import updateFastifyWithChatRoute, {
  type ChatRouteOptions
} from "../../../../../src/modules/chat/routes/chatRoute"
import {
  ChatCompletionCancelledError,
  ConversationNotFoundError
} from "../../../../../src/utils/errors"
import {
  createChatRouteTestApp,
  sendChatRequest,
  TEST_LYS_SYSTEM_PROMPT
} from "../../../support/chatRouteTestApp"
import { parseSseEvents } from "../../../support/chatSseRoute"
import {
  createConversationTurn as createConversationTurnFixture,
  createFixtureUuidV7
} from "../../../support/conversationFixtures"
import { createChatCompletionChunk } from "../../../support/openAiEndpointFake"
import {
  READ_TEXT_FILE_FORMAT,
  READ_TEXT_FILE_TOOL
} from "../../../support/toolFixtures"

/** Settings applied by the chat route in every case. */
const CHAT_ROUTE_OPTIONS = Object.freeze({
  titleGenerationMaxAttempts: 2
} satisfies ChatRouteOptions)

/** Valid request body starting a new conversation that Lys answers. */
const NEW_CONVERSATION_REQUEST = Object.freeze({
  conversation: { kind: "new", agentCode: "lys" },
  message: "Plan my trip",
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4 }
})

/** Definition of a stored agent, which cannot answer chats yet. */
const WEB_RESEARCHER_DEFINITION = Object.freeze({
  code: "web-researcher",
  name: "Web Researcher",
  bio: "Searches the web.",
  systemPrompt: "You research the web."
})

describe("updateFastifyWithChatRoute", () => {
  it("responds with the missing-conversation problem before contacting the model", async () => {
    const testApp = await createChatRouteTestApp()
    testApp.createConversationTurn.mockImplementation(() => {
      throw new ConversationNotFoundError()
    })
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
    expect(testApp.createConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: { kind: "existing", id: conversationId }
      })
    )
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
    expect(testApp.logs).toContainEqual(
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
        conversation: { kind: "new", agentCode: "Lys" }
      }
    ],
    [
      "an agent code on a continued conversation",
      {
        ...NEW_CONVERSATION_REQUEST,
        conversation: {
          kind: "existing",
          id: createFixtureUuidV7(1),
          agentCode: "lys"
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
        conversation: { kind: "new", agentCode: "lys" },
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

  it.each([
    ["no agent has", []],
    ["only a stored agent has", [WEB_RESEARCHER_DEFINITION]]
  ])(
    "responds with the missing-agent problem before storing a turn when a new conversation names a code %s",
    async (_label, storedDefinitions) => {
      const testApp = await createChatRouteTestApp()
      for (const definition of storedDefinitions)
        testApp.app.agentService.createAgent(definition)
      updateFastifyWithChatRoute(testApp.app, {
        ...CHAT_ROUTE_OPTIONS,
        generations: testApp.generations
      })

      const response = await sendChatRequest(testApp.app, {
        ...NEW_CONVERSATION_REQUEST,
        conversation: { kind: "new", agentCode: "web-researcher" }
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      expect(agentNotFoundProblemSchema.parse(response.json())).toMatchObject({
        detail: "No agent that can answer chats has the code web-researcher.",
        instance: chatApi.path
      })
      expect(testApp.createConversationTurn).not.toHaveBeenCalled()
      expect(testApp.completeChatStream).not.toHaveBeenCalled()
      expect(testApp.generateTitle).not.toHaveBeenCalled()
    }
  )

  it("has the Lys agent answer with her own system prompt and streams the stored reply", async () => {
    const testApp = await createChatRouteTestApp()
    // Store the turn for real, so the reply's writes reach a stored message.
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

    const response = await sendChatRequest(
      testApp.app,
      NEW_CONVERSATION_REQUEST
    )

    expect(response.statusCode).toBe(200)
    expect(parseSseEvents(response.body)[0]).toMatchObject({
      event: "start-new-conversation-turn",
      data: { conversation: { agentCode: "lys" } }
    })
    expect(testApp.completeChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: TEST_LYS_SYSTEM_PROMPT },
          { role: "user", content: NEW_CONVERSATION_REQUEST.message }
        ],
        model: NEW_CONVERSATION_REQUEST.model
      })
    )
    const replyEvents = parseSseEvents(response.body).filter(
      ({ event }) => event === "delta" || event === "done"
    )
    expect(replyEvents).toEqual([
      { event: "delta", data: { type: "delta", content: "Hi" } },
      { event: "done", data: { type: "done", finishReason: "stop" } }
    ])
  })

  it.each([
    [
      "offers the request's client tools to the model",
      { definitions: [READ_TEXT_FILE_TOOL] },
      [READ_TEXT_FILE_FORMAT]
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

  it("fails the stored reply with a server error, without contacting the model, when the conversation's agent is not available", async () => {
    const testApp = await createChatRouteTestApp()
    const turn = createConversationTurnFixture({
      agentCode: "retired-agent",
      earlierMessages: [],
      userMessageContent: "Plan my trip"
    })
    testApp.createConversationTurn.mockReturnValue(turn)
    const updateAssistantMessageState = vi.spyOn(
      testApp.app.conversationTurns,
      "updateAssistantMessageState"
    )
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversation: { kind: "existing", id: turn.conversation.id }
    })

    expect(response.statusCode).toBe(500)
    expect(updateAssistantMessageState).toHaveBeenCalledWith(
      turn.assistantMessage.id,
      { status: "failed" }
    )
    expect(testApp.logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({
          message: "Conversation agent retired-agent is not available"
        })
      })
    )
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
    expect(testApp.generateTitle).not.toHaveBeenCalled()
  })

  it("keeps the missing-agent failure observable when the failed reply cannot be stored", async () => {
    const testApp = await createChatRouteTestApp()
    const turn = createConversationTurnFixture({
      agentCode: "retired-agent",
      earlierMessages: [],
      userMessageContent: "Plan my trip"
    })
    testApp.createConversationTurn.mockReturnValue(turn)
    vi.spyOn(
      testApp.app.conversationTurns,
      "updateAssistantMessageState"
    ).mockImplementation(() => {
      throw new Error("database is locked")
    })
    updateFastifyWithChatRoute(testApp.app, {
      ...CHAT_ROUTE_OPTIONS,
      generations: testApp.generations
    })

    const response = await sendChatRequest(testApp.app, {
      ...NEW_CONVERSATION_REQUEST,
      conversation: { kind: "existing", id: turn.conversation.id }
    })

    expect(response.statusCode).toBe(500)
    expect(testApp.logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        err: expect.objectContaining({
          type: "AggregateError",
          aggregateErrors: [
            expect.objectContaining({
              message: "Conversation agent retired-agent is not available"
            }),
            expect.objectContaining({ message: "database is locked" })
          ]
        })
      })
    )
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
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
      expect(testApp.logs).toContainEqual(
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
})
