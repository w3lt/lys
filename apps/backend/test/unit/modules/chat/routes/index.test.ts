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
import {
  createDownloadedLlmModel,
  LM_STUDIO_QWEN3_8B
} from "../../../support/llmFixtures"
import { createChatCompletionChunk } from "../../../support/openAiEndpointFake"
import { TOOL_CALL_POLICY } from "../../../support/toolFixtures"

/** Model both requests of the shared-memory case name. */
const MODEL = LM_STUDIO_QWEN3_8B

describe("registerChatRoutes", () => {
  it.each([
    ["chat", chatApi],
    ["chat-context", chatContextApi],
    ["reply-events", chatReplyEventsApi],
    ["reply-stop", stopChatReplyApi]
  ])("installs the %s endpoint", async (_label, endpoint) => {
    const testApp = await createChatRouteTestApp()

    await registerChatRoutes(testApp.app, {
      titleGenerationMaxAttempts: 1,
      toolCallPolicy: TOOL_CALL_POLICY
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
      createDownloadedLlmModel({ modelKey: MODEL.modelKey })
    ])
    await registerChatRoutes(testApp.app, {
      titleGenerationMaxAttempts: 1,
      toolCallPolicy: TOOL_CALL_POLICY
    })

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
