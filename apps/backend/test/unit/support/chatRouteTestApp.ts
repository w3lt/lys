import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { validatorCompiler } from "fastify-type-provider-zod"
import { onTestFinished, vi, type MockInstance } from "vitest"
import ChatService from "../../../src/di/services/chatService"
import SqliteConversationStore from "../../../src/di/services/conversationService"
import type SqliteConversationTurns from "../../../src/di/services/conversationService/turns"
import { createChatSseTestApp } from "./chatSseRoute"
import type { TestFastify } from "./fastifyTestApp"

/** Published path of the chat route. */
const CHAT_PATH = "/api/v1/chat"

/** Test application decorated with the services the chat route borrows. */
export type ChatRouteTestApp = TestFastify &
  Readonly<{
    /**
     * Store access the route borrows at registration; returns
     * {@link ChatRouteTestApp.turns} until a case replaces it.
     */
    createTurnAccess: MockInstance<SqliteConversationStore["createTurnAccess"]>
    /** Turn creation of the borrowed access; throws until a case configures it. */
    createConversationTurn: MockInstance<
      SqliteConversationTurns["createConversationTurn"]
    >
    /** Chat completion of `app.chatService`; rejects if it is ever called. */
    completeChatStream: MockInstance<ChatService["completeChatStream"]>
    /** Title generation of `app.chatService`; rejects if it is ever called. */
    generateTitle: MockInstance<ChatService["generateTitle"]>
  }>

/**
 * Creates an application with SSE and schema validation whose conversation
 * store and chat service are real instances with every call the chat route
 * can reach replaced by a spy.
 *
 * @returns The application, captured logs, and the spies.
 * @throws If the SSE plugin cannot be registered.
 * @remarks The chat route is not registered; each case calls the registrar
 * under test. Unconfigured turn creation throws and both chat-service calls
 * reject with `Unexpected chat route call: <name>`, so a case that reaches
 * persistence or the model without arranging it fails. No database row is
 * written and no HTTP request leaves the process. The in-memory store is
 * disposed when the test finishes.
 */
export async function createChatRouteTestApp(): Promise<ChatRouteTestApp> {
  const testFastify = await createChatSseTestApp()
  const store = SqliteConversationStore.open(":memory:")
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  const turns = store.createTurnAccess()
  const createTurnAccess = vi
    .spyOn(store, "createTurnAccess")
    .mockReturnValue(turns)
  const createConversationTurn = vi
    .spyOn(turns, "createConversationTurn")
    .mockImplementation(() => rejectUnexpectedCall("createConversationTurn"))
  const chatService = new ChatService({
    openAiBaseUrl: "http://lmstudio.test/v1",
    titleGenerationPrompt: "Summarize the message as a short title.",
    generatedTitleMaxLength: 50
  })
  const completeChatStream = vi
    .spyOn(chatService, "completeChatStream")
    .mockImplementation(async () => rejectUnexpectedCall("completeChatStream"))
  const generateTitle = vi
    .spyOn(chatService, "generateTitle")
    .mockImplementation(async () => rejectUnexpectedCall("generateTitle"))
  testFastify.app.setValidatorCompiler(validatorCompiler)
  testFastify.app.decorate("conversationService", store)
  testFastify.app.decorate("chatService", chatService)
  return Object.freeze({
    ...testFastify,
    createTurnAccess,
    createConversationTurn,
    completeChatStream,
    generateTitle
  })
}

/**
 * Sends one chat request accepting an event stream.
 *
 * @param app - Application with the chat route registered.
 * @param payload - Raw request body, serialized as JSON.
 * @returns The completed response.
 */
export async function requestChat(
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
function rejectUnexpectedCall(operationName: string): never {
  throw new Error(`Unexpected chat route call: ${operationName}`)
}
