import { chatApi } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import registerChatRoutes from "../../../../src/modules/chat"
import { createChatRouteTestApp } from "../../support/chatRouteTestApp"

describe("registerChatRoutes", () => {
  it("installs the chat endpoint", async () => {
    const testApp = await createChatRouteTestApp()

    await registerChatRoutes(testApp.app, {
      lysSystemPrompt: "Configured prompt",
      titleGenerationMaxAttempts: 1
    })

    expect(
      testApp.app.hasRoute({ method: chatApi.method, url: chatApi.path })
    ).toBe(true)
  })
})
