import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { validatorCompiler } from "fastify-type-provider-zod"
import { onTestFinished, vi, type MockInstance } from "vitest"
import SqliteAgentRecordStore from "../../../src/infrastructure/database/agents/sqliteAgentRecordStore"
import AgentService from "../../../src/modules/agent/agentService"
import ChatService from "../../../src/modules/chat/chatService"
import OpenAiReplyModel from "../../../src/modules/chat/openAiReplyModel"
import type StoredConversationTurns from "../../../src/modules/conversation/turns"
import ReplyGenerationRegistry from "../../../src/modules/chat/replyGenerationRegistry"
import { createChatSseTestApp } from "./chatSseRoute"
import { openConversationTestServices } from "./conversationDatabase"
import type { TestFastify } from "./fastifyTestApp"
import { LOOK_UP_WORD_TOOL, ScriptedBuiltInTool } from "./scriptedBuiltInTool"

/** Published path of the chat route. */
const CHAT_PATH = "/api/v1/chat"

/**
 * System prompt of the Lys agent in the chat route test app; it differs from
 * every stored prompt so a case can tell which one the model received.
 */
export const TEST_LYS_SYSTEM_PROMPT = "You are the test Lys."

/** Test application decorated with the services the chat route borrows. */
export type ChatRouteTestApp = TestFastify &
  Readonly<{
    /**
     * Turn creation of `app.conversationTurns`; throws until a case configures
     * it.
     */
    createConversationTurn: MockInstance<
      StoredConversationTurns["createConversationTurn"]
    >
    /** Chat completion of `app.chatService`; rejects if it is ever called. */
    completeChatStream: MockInstance<ChatService["completeChatStream"]>
    /** Title generation of `app.chatService`; rejects if it is ever called. */
    generateTitle: MockInstance<ChatService["generateTitle"]>
    /**
     * Registry a case passes to the chat route; disposed when the test
     * finishes, before the conversation database closes.
     */
    generations: ReplyGenerationRegistry
  }>

/**
 * Creates an application with SSE and schema validation whose conversation
 * turns and chat service are real instances with every call the chat route
 * can reach replaced by a spy.
 *
 * @returns The application, captured logs, and the spies.
 * @throws If the SSE plugin cannot be registered.
 * @remarks The chat route is not registered; each case calls the registrar
 * under test. Unconfigured turn creation throws and both chat-service calls
 * reject with `Unexpected chat route call: <name>`, so a case that reaches
 * persistence or the model without arranging it fails. No database row is
 * written and no HTTP request leaves the process. The decorated agent service
 * keeps its records on the same in-memory database and builds Lys with
 * {@link TEST_LYS_SYSTEM_PROMPT}; Lys's model calls go through the
 * `completeChatStream` spy. The only backend tool is the scripted
 * `look_up_word` tool. When the test finishes, the registry is disposed
 * first, so every generation it holds has stored its final state before the
 * in-memory conversation database is closed.
 */
export async function createChatRouteTestApp(): Promise<ChatRouteTestApp> {
  const testFastify = await createChatSseTestApp()
  const { database, turns } = openConversationTestServices()
  const createConversationTurn = vi
    .spyOn(turns, "createConversationTurn")
    .mockImplementation(() => handleUnexpectedCall("createConversationTurn"))
  const chatService = new ChatService({
    openAiBaseUrl: "http://lmstudio.test/v1",
    titleGenerationPrompt: "Summarize the message as a short title.",
    generatedTitleMaxLength: 50
  })
  const completeChatStream = vi
    .spyOn(chatService, "completeChatStream")
    .mockImplementation(() =>
      Promise.reject(createUnexpectedCallError("completeChatStream"))
    )
  const generateTitle = vi
    .spyOn(chatService, "generateTitle")
    .mockImplementation(() =>
      Promise.reject(createUnexpectedCallError("generateTitle"))
    )
  const agentService = new AgentService({
    recordStore: new SqliteAgentRecordStore(database),
    lysSystemPrompt: TEST_LYS_SYSTEM_PROMPT,
    replyModel: new OpenAiReplyModel((options) =>
      chatService.completeChatStream(options)
    )
  })
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  testFastify.app.setValidatorCompiler(validatorCompiler)
  testFastify.app.decorate("conversationTurns", turns)
  testFastify.app.decorate("chatService", chatService)
  testFastify.app.decorate("agentService", agentService)
  testFastify.app.decorate(
    "builtInTools",
    Object.freeze([
      Object.freeze({
        definition: LOOK_UP_WORD_TOOL,
        tool: new ScriptedBuiltInTool()
      })
    ])
  )
  return Object.freeze({
    ...testFastify,
    createConversationTurn,
    completeChatStream,
    generateTitle,
    generations
  })
}

/**
 * Sends one chat request accepting an event stream.
 *
 * @param app - Application with the chat route registered.
 * @param payload - Raw request body, serialized as JSON.
 * @returns The completed response.
 */
export async function sendChatRequest(
  app: FastifyInstance,
  payload: unknown
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: "POST",
    url: CHAT_PATH,
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json"
    },
    payload: JSON.stringify(payload)
  })
}

/**
 * Fails a chat-route dependency call that the current case did not arrange.
 *
 * @param operationName - Dependency operation that was called.
 * @throws Always.
 */
function handleUnexpectedCall(operationName: string): never {
  throw createUnexpectedCallError(operationName)
}

/**
 * Creates the failure for a chat-route dependency call that the current case
 * did not arrange.
 *
 * @param operationName - Dependency operation that was called.
 * @returns An error with the message `Unexpected chat route call: <name>`.
 */
function createUnexpectedCallError(operationName: string): Error {
  return new Error(`Unexpected chat route call: ${operationName}`)
}
