import {
  agentNotFoundProblemSchema,
  chatApi,
  conversationAgentMissingProblemSchema,
  conversationNotFoundProblemSchema
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import updateFastifyWithChatRoute, {
  type ChatRouteOptions
} from "../../../../../src/modules/chat/routes/chatRoute"
import { ChatCompletionCancelledError } from "../../../../../src/utils/errors"
import {
  createChatRouteTestApp,
  sendChatRequest,
  TEST_BUILT_IN_AGENT_PROMPTS,
  type ChatRouteTestApp
} from "../../../support/chatRouteTestApp"
import { parseSseEvents } from "../../../support/chatSseRoute"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"
import { createChatCompletionChunk } from "../../../support/openAiEndpointFake"
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
  const start: unknown = parseSseEvents(response.body)[0]?.data
  const conversationId =
    start !== null &&
    typeof start === "object" &&
    "conversation" in start &&
    start.conversation !== null &&
    typeof start.conversation === "object" &&
    "id" in start.conversation
      ? start.conversation.id
      : undefined
  if (typeof conversationId !== "string")
    throw new Error("The chat route did not start a new conversation")
  return conversationId
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
        ({ event }) => event === "delta" || event === "done"
      )
      expect(replyEvents).toEqual([
        { event: "delta", data: { type: "delta", content: "Hi" } },
        { event: "done", data: { type: "done", finishReason: "stop" } }
      ])
    }
  )

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
