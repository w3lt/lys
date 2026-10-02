import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { validatorCompiler } from "fastify-type-provider-zod"
import { onTestFinished, vi, type MockInstance } from "vitest"
import ChatService from "../../../src/di/services/chatService"
import type SqliteConversationTurns from "../../../src/di/services/conversationService/turns"
import ReplyGenerationRegistry from "../../../src/modules/chat/chat/replyGenerationRegistry"
import { createChatSseTestApp } from "./chatSseRoute"
import { openConversationTestServices } from "./conversationDatabase"
import type { TestFastify } from "./fastifyTestApp"

/** Published path of the chat route. */
const CHAT_PATH = "/api/v1/chat"

/** Test application decorated with the services the chat route borrows. */
export type ChatRouteTestApp = TestFastify &
  Readonly<{
    /**
     * Turn creation of `app.conversationTurns`; throws until a case configures
     * it.
     */
    createConversationTurn: MockInstance<
      SqliteConversationTurns["createConversationTurn"]
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
 * written and no HTTP request leaves the process. When the test finishes, the
 * registry is disposed first, so every generation it holds has stored its
 * final state before the in-memory conversation database is closed.
 */
export async function createChatRouteTestApp(): Promise<ChatRouteTestApp> {
  const testFastify = await createChatSseTestApp()
  const { turns } = openConversationTestServices()
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
    .mockImplementation(async () => handleUnexpectedCall("completeChatStream"))
  const generateTitle = vi
    .spyOn(chatService, "generateTitle")
    .mockImplementation(async () => handleUnexpectedCall("generateTitle"))
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  testFastify.app.setValidatorCompiler(validatorCompiler)
  testFastify.app.decorate("conversationTurns", turns)
  testFastify.app.decorate("chatService", chatService)
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
  throw new Error(`Unexpected chat route call: ${operationName}`)
}
