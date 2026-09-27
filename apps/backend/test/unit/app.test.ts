import { chatApiStreamEventSchema } from "@lys/protocol"
import type { FastifyInstance } from "fastify"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { buildApp } from "../src/app"
import { TEST_BACKEND_CONFIG } from "./support/backendConfig"
import {
  isStreamedRequest,
  requestChat,
  respondWithChatAndTitle
} from "./support/chatRouteTestApp"
import { createLmStudioLlmRecord } from "./support/llmFixtures"
import { fakeLmStudio } from "./support/lmStudioSdkFake"
import {
  createChatCompletionChunk,
  installOpenAiEndpointFake,
  type OpenAiEndpointResponder
} from "./support/openAiEndpointFake"

vi.mock("@lmstudio/sdk", () => import("./support/lmStudioSdkFake"))

/**
 * Builds the application with the test configuration and owns its closing.
 *
 * @param respond - Behavior of the OpenAI-compatible endpoint.
 * @returns The ready application and the endpoint's request log.
 */
async function buildOwnedApp(respond: OpenAiEndpointResponder) {
  const endpoint = installOpenAiEndpointFake(respond)
  const app = await buildApp({ config: TEST_BACKEND_CONFIG })
  onTestFinished(async () => {
    await app.close()
  })
  return { app, endpoint }
}

/**
 * Lists whether each published backend route is registered.
 *
 * @param app - Ready application.
 * @returns Registration status per method and path.
 */
function describeRoutes(app: FastifyInstance) {
  return [
    ["GET", "/api/v1/heath"],
    ["GET", "/api/v1/llm/list"],
    ["POST", "/api/v1/llm/load"],
    ["PATCH", "/api/v1/llm/unload"],
    ["GET", "/api/v1/llm/:modelId/health"],
    ["POST", "/api/v1/chat"],
    ["GET", "/api/v1/conversations"],
    ["GET", "/api/v1/conversations/:conversationId"],
    ["PATCH", "/api/v1/conversations/:conversationId"],
    ["DELETE", "/api/v1/conversations/:conversationId"]
  ].map(([method = "", url = ""]) => ({
    method,
    url,
    registered: app.hasRoute({ method, url })
  }))
}

describe("buildApp", () => {
  beforeEach(() => {
    fakeLmStudio.reset()
  })

  it("registers every published backend route", async () => {
    const { app } = await buildOwnedApp(() => {
      throw new Error("Unexpected model request")
    })
    await app.ready()

    expect(describeRoutes(app).filter(({ registered }) => !registered)).toEqual(
      []
    )
  })

  it("serves the inventory of the configured LM Studio endpoint", async () => {
    fakeLmStudio.downloadedModels = [
      createLmStudioLlmRecord({ modelKey: "qwen/qwen3-8b" })
    ]
    const { app } = await buildOwnedApp(() => {
      throw new Error("Unexpected model request")
    })

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/llm/list"
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      llms: [{ modelKey: "qwen/qwen3-8b", loaded: false }]
    })
    expect(fakeLmStudio.clients).toEqual([
      { baseUrl: "ws://lmstudio.test:4321", disposeCount: 0 }
    ])
  })

  it("applies the configured system prompt and title attempt limit to chat", async () => {
    const { app, endpoint } = await buildOwnedApp(
      respondWithChatAndTitle(
        [createChatCompletionChunk({ content: "Hi", finishReason: "stop" })],
        "   "
      )
    )

    const response = await requestChat(app, {
      message: "Hello",
      model: "qwen/qwen3-8b",
      generationOptions: { temperature: 0.4 }
    })

    const start = chatApiStreamEventSchema.parse(response.events[0]?.data)
    expect(start).toMatchObject({
      type: "start-new-conversation-turn",
      conversation: { systemPrompt: TEST_BACKEND_CONFIG.lysSystemPrompt }
    })
    expect(
      endpoint.requests.filter(({ body }) => !isStreamedRequest(body))
    ).toHaveLength(TEST_BACKEND_CONFIG.titleGenerationMaxAttempts)
  })

  it("releases the LM Studio client when the application closes", async () => {
    const { app } = await buildOwnedApp(() => {
      throw new Error("Unexpected model request")
    })

    await app.close()

    expect(fakeLmStudio.clients[0]?.disposeCount).toBe(1)
  })

  it("rejects and releases the LM Studio client when the runtime is unavailable", async () => {
    installOpenAiEndpointFake(() => {
      throw new Error("Unexpected model request")
    })
    fakeLmStudio.operations.getLMStudioVersion = async () => {
      throw new Error("connect ECONNREFUSED")
    }

    await expect(buildApp({ config: TEST_BACKEND_CONFIG })).rejects.toThrow(
      "The LLM runtime is unavailable."
    )

    expect(fakeLmStudio.clients[0]?.disposeCount).toBe(1)
  })
})
