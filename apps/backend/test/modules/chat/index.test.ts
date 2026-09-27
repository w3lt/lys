import { describe, expect, it } from "vitest"
import registerChatRoutes from "../../../src/modules/chat"
import {
  createChatRouteTestApp,
  requestChat,
  respondWithChatAndTitle
} from "../../support/chatRouteTestApp"
import { createChatCompletionChunk } from "../../support/openAiEndpointFake"

describe("registerChatRoutes", () => {
  it("installs the chat endpoint with the supplied system prompt and title limit", async () => {
    const testApp = await createChatRouteTestApp(
      respondWithChatAndTitle(
        [createChatCompletionChunk({ content: "Hi", finishReason: "stop" })],
        "   "
      )
    )

    await registerChatRoutes(testApp.app, {
      lysSystemPrompt: "Configured prompt",
      titleGenerationMaxAttempts: 1
    })
    const response = await requestChat(testApp.app, {
      message: "Hello",
      model: "qwen/qwen3-8b",
      generationOptions: { temperature: 0.4 }
    })

    expect(response.statusCode).toBe(200)
    expect(response.events[0]?.data).toMatchObject({
      type: "start-new-conversation-turn",
      conversation: { systemPrompt: "Configured prompt" }
    })
    expect(testApp.endpoint.requests).toHaveLength(2)
  })
})
