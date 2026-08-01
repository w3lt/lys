import type { BackendConfig } from "../config"
import ChatService from "./services/chatService"
import ConversationService from "./services/conversationService"
import LlmService from "./services/llmService"

/** Application-scoped services owned for a Fastify application's lifetime. */
export type SingletonServices = Readonly<{
  /** Chat completion adapter configured for the backend's local endpoint. */
  chatService: ChatService
  /** LM Studio lifecycle and inventory adapter configured for the backend's local endpoint. */
  llmService: LlmService
  conversationService: ConversationService
}>

/**
 * Creates the application-scoped service bundle from backend network configuration.
 *
 * @param config - LM Studio host and port used to derive local service endpoints.
 * @returns The owned service bundle configured with the HTTP `/v1` chat endpoint and WebSocket LM Studio endpoint.
 * @throws If synchronous SDK client construction fails.
 */
export function createSingletonServices(
  config: BackendConfig
): SingletonServices {
  const chatService = new ChatService({
    openAiBaseUrl: `http://${config.lmstudioHost}:${config.lmstudioPort}/v1`
  })

  const llmService = new LlmService({
    lmsBaseUrl: `ws://${config.lmstudioHost}:${config.lmstudioPort}`
  })

  const conversationService = new ConversationService({
    databaseFilePath: config.databaseFilePath
  })

  return {
    chatService,
    llmService,
    conversationService
  }
}

/**
 * Disposes the application-scoped singleton services sequentially.
 *
 * @param services - Service bundle owned by the closing application.
 * @returns A promise that resolves after all services have been disposed.
 * @throws If a service cannot complete asynchronous disposal.
 * @remarks Disposal stops at the first rejected service operation, so later services are not disposed after a failure.
 */
export async function disposeSingletonServices(
  services: SingletonServices
): Promise<void> {
  await services.chatService[Symbol.asyncDispose]()
  await services.llmService[Symbol.asyncDispose]()
  services.conversationService[Symbol.dispose]()
}
