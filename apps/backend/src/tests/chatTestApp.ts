import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import ChatService from "../di/services/chatService"
import SqliteConversationStore from "../di/services/conversationService"
import registerChatRoutes from "../modules/chat"
import updateFastifyWithConversationRoutes from "../modules/conversation"
import { updateFastifyWithHttpTransport } from "../http"

/** Real HTTP and SQLite boundaries whose cleanup is retained by the test runner. */
export type ChatTestApp = Readonly<{
  /** Configured injectable app using production transport and route registration. */
  app: FastifyInstance
  /** Isolated temporary SQLite store. */
  store: SqliteConversationStore
  /** Model boundary whose external requests are replaced by each test. */
  chatService: ChatService
  /** Synthetic database path for real storage failure and reopen assertions. */
  databaseFilePath: string
}>

/**
 * Creates production routes over isolated SQLite without connecting to LM Studio.
 * @param context - Runner owner of failure-safe, reverse-order cleanup and mocks.
 * @returns Ready app, store, and external inference boundary for the current test.
 * @throws If isolated setup fails; the runner still releases acquired resources.
 */
export async function createChatTestApp(
  context: TestContext
): Promise<ChatTestApp> {
  const lifetime = new AsyncDisposableStack()
  context.after(() => lifetime.disposeAsync())
  const directory = mkdtempSync(join(tmpdir(), "lys-chat-test-"))
  lifetime.defer(() => rmSync(directory, { recursive: true, force: true }))
  const databaseFilePath = join(directory, "history.sqlite")
  const store = lifetime.use(SqliteConversationStore.open(databaseFilePath))
  const app = lifetime.use(Fastify())
  const chatService = new ChatService({
    openAiBaseUrl: "http://127.0.0.1:1/v1"
  })
  app.addHook("onClose", async () => store[Symbol.dispose]())
  app.decorate("conversationService", store)
  app.decorate("chatService", chatService)
  await updateFastifyWithHttpTransport(app)
  await app.register(registerChatRoutes)
  await app.register(updateFastifyWithConversationRoutes)
  return { app, store, chatService, databaseFilePath }
}
