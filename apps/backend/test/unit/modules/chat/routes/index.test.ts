import {
  chatApi,
  chatContextApi,
  chatReplyEventsApi,
  stopChatReplyApi
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import registerChatRoutes from "../../../../../src/modules/chat/routes"
import {
  createChatRouteTestApp,
  sendChatRequest
} from "../../../support/chatRouteTestApp"
import { createDownloadedLlmModel } from "../../../support/llmFixtures"
import { createChatCompletionChunk } from "../../../support/openAiEndpointFake"

/** Model both requests of the shared-memory case name. */
const MODEL = "qwen/qwen3-8b"

describe("registerChatRoutes", () => {
  it.each([
    ["chat", chatApi],
    ["chat-context", chatContextApi],
    ["reply-events", chatReplyEventsApi],
    ["reply-stop", stopChatReplyApi]
  ])("installs the %s endpoint", async (_label, endpoint) => {
    const testApp = await createChatRouteTestApp()

    await registerChatRoutes(testApp.app, {
      titleGenerationMaxAttempts: 1
    })

    expect(
      testApp.app.hasRoute({ method: endpoint.method, url: endpoint.path })
    ).toBe(true)
  })

  it("reads a model's capabilities once for the chat and chat-context endpoints together", async () => {
    const testApp = await createChatRouteTestApp()
    testApp.createConversationTurn.mockRestore()
    testApp.completeChatStream.mockImplementation(async () =>
      (async function* () {
        yield createChatCompletionChunk({ content: "Hi", finishReason: "stop" })
      })()
    )
    testApp.generateTitle.mockResolvedValue("Trip plan")
    testApp.listDownloadedLlmModels.mockResolvedValue([
      createDownloadedLlmModel({ modelKey: MODEL })
    ])
    await registerChatRoutes(testApp.app, { titleGenerationMaxAttempts: 1 })

    const chat = await sendChatRequest(testApp.app, {
      conversation: { kind: "new", agentCode: "caliginia" },
      message: "Plan my trip",
      model: MODEL,
      generationOptions: { temperature: 0.4 }
    })
    const context = await testApp.app.inject({
      method: chatContextApi.method,
      url: chatContextApi.path,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        conversation: { kind: "new", agentCode: "caliginia" },
        model: MODEL
      })
    })

    expect(chat.statusCode).toBe(200)
    expect(context.statusCode).toBe(200)
    expect(testApp.listDownloadedLlmModels).toHaveBeenCalledOnce()
  })
})
