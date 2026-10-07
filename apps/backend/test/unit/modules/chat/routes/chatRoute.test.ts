import { chatApi, conversationNotFoundProblemSchema } from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import updateFastifyWithChatRoute, {
  type ChatRouteOptions
} from "../../../../../src/modules/chat/routes/chatRoute"
import { ConversationNotFoundError } from "../../../../../src/utils/errors"
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

/** Settings applied by the chat route in every case. */
const CHAT_ROUTE_OPTIONS = Object.freeze({
  titleGenerationMaxAttempts: 2
} satisfies ChatRouteOptions)

/** Valid request body starting a new conversation. */
const NEW_CONVERSATION_REQUEST = Object.freeze({
  message: "Plan my trip",
  model: "qwen/qwen3-8b",
  generationOptions: { temperature: 0.4 }
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
      conversationId
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
      expect.objectContaining({ conversationId })
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
      { ...NEW_CONVERSATION_REQUEST, conversationId: "conversation-1" }
    ],
    [
      "missing generation options",
      { message: "Plan my trip", model: "qwen/qwen3-8b" }
    ],
    ["an unknown field", { ...NEW_CONVERSATION_REQUEST, stream: true }]
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
      conversationId: turn.conversation.id
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
})
