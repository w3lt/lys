import {
  agentNotFoundProblemSchema,
  chatApi,
  chatBackendToolUnavailableProblemSchema,
  chatApiStreamEventSchema,
  conversationAgentMissingProblemSchema,
  conversationNotFoundProblemSchema
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import type ReplyGeneration from "../../../../../src/modules/chat/replyGeneration"
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
    expect(testApp.logs).toContainEqual(
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

  it("logs a round that was not sent because the model is not loaded at debug level, not as a failure", async () => {
    const testApp = await createChatRouteTestApp()
    registerStoringChatRoute(testApp)
    testApp.findLlmContextMeasurement.mockResolvedValue(undefined)

    const response = await sendChatRequest(
      testApp.app,
      NEW_CONVERSATION_REQUEST
    )

    expect(response.statusCode).toBe(200)
    expect(testApp.logs).toContainEqual(
      expect.objectContaining({
        level: "debug",
        msg: "Chat round was not sent to the model",
        reqId: expect.any(String),
        err: expect.objectContaining({
          message: `The model "${NEW_CONVERSATION_REQUEST.model}" is not loaded`
        })
      })
    )
    expect(testApp.logs).not.toContainEqual(
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

      expect(testApp.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          reqId: expect.any(String),
          msg: expect.stringContaining("Just run")
        })
      )
    })
  })
})
