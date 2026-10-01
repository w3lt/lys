import { chatApi, conversationNotFoundProblemSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import updateFastifyWithChatRoute, {
  type ChatRouteOptions
} from "../../../../../src/modules/chat/chat"
import { ConversationNotFoundError } from "../../../../../src/utils/errors"
import {
  createChatRouteTestApp,
  requestChat
} from "../../../support/chatRouteTestApp"
import { createFixtureUuidV7 } from "../../../support/conversationFixtures"

/** Settings applied by the chat route in every case. */
const CHAT_ROUTE_OPTIONS = Object.freeze({
  lysSystemPrompt: "You are Lys.",
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

    const response = await requestChat(testApp.app, {
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
    expect(problem).toMatchObject({
      detail: `Conversation ${conversationId} was not found.`,
      instance: chatApi.path
    })
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

    const response = await requestChat(testApp.app, NEW_CONVERSATION_REQUEST)

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

    const response = await requestChat(testApp.app, payload)

    expect(response.statusCode).toBe(400)
    expect(testApp.createConversationTurn).not.toHaveBeenCalled()
    expect(testApp.completeChatStream).not.toHaveBeenCalled()
    expect(testApp.generateTitle).not.toHaveBeenCalled()
  })

  it("fails registration when the turn access cannot be borrowed", async () => {
    const testApp = await createChatRouteTestApp()
    const accessFailure = new Error("turn access unavailable")
    testApp.createTurnAccess.mockImplementation(() => {
      throw accessFailure
    })

    let failure: unknown
    try {
      updateFastifyWithChatRoute(testApp.app, {
        ...CHAT_ROUTE_OPTIONS,
        generations: testApp.generations
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBe(accessFailure)
  })
})
