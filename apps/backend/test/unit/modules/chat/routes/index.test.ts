import { chatApi, chatReplyEventsApi, stopChatReplyApi } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import registerChatRoutes from "../../../../../src/modules/chat/routes"
import { createChatRouteTestApp } from "../../../support/chatRouteTestApp"

describe("registerChatRoutes", () => {
  it.each([
    ["chat", chatApi],
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
})
