import { beforeEach, describe, expect, it, vi } from "vitest"
import singletonServicesPlugin from "../../src/di/fastify"
import ChatService from "../../src/di/services/chatService"
import SqliteConversationStore from "../../src/di/services/conversationService"
import LlmService from "../../src/di/services/llmService"
import { TEST_BACKEND_CONFIG } from "../support/backendConfig"
import { createTestFastify } from "../support/fastifyTestApp"
import { fakeLmStudio } from "../support/lmStudioSdkFake"

vi.mock("@lmstudio/sdk", () => import("../support/lmStudioSdkFake"))

describe("singletonServicesPlugin", () => {
  beforeEach(() => {
    fakeLmStudio.reset()
  })

  it("decorates the application with the three application services", async () => {
    const { app } = createTestFastify()

    await app.register(singletonServicesPlugin, { config: TEST_BACKEND_CONFIG })
    await app.ready()

    expect(app.chatService).toBeInstanceOf(ChatService)
    expect(app.llmService).toBeInstanceOf(LlmService)
    expect(app.conversationService).toBeInstanceOf(SqliteConversationStore)
  })

  it("makes the services visible to plugins registered beside it", async () => {
    const { app } = createTestFastify()
    let siblingSawLlmService = false

    await app.register(singletonServicesPlugin, { config: TEST_BACKEND_CONFIG })
    await app.register(async (sibling) => {
      siblingSawLlmService = sibling.llmService instanceof LlmService
    })
    await app.ready()

    expect(siblingSawLlmService).toBe(true)
  })

  it("releases the services when the application closes", async () => {
    const { app } = createTestFastify()
    await app.register(singletonServicesPlugin, { config: TEST_BACKEND_CONFIG })
    await app.ready()
    const store = app.conversationService

    await app.close()

    expect(fakeLmStudio.clients[0]?.disposeCount).toBe(1)
    expect(() => store.createHistoryAccess()).toThrow(
      "Conversation store is closed"
    )
  })

  it("fails application startup when the services cannot be created", async () => {
    fakeLmStudio.operations.getLMStudioVersion = async () => {
      throw new Error("connect ECONNREFUSED")
    }
    const { app } = createTestFastify()

    await expect(
      app.register(singletonServicesPlugin, { config: TEST_BACKEND_CONFIG })
    ).rejects.toThrow("The LLM runtime is unavailable.")

    expect(app.hasDecorator("llmService")).toBe(false)
    expect(fakeLmStudio.clients[0]?.disposeCount).toBe(1)
  })
})
