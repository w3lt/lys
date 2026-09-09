/// <reference types="fastify" />

import type ChatService from "./di/services/chatService"
import type ConversationService from "./di/services/conversationService"
import type {
  LlmModelInventory,
  LlmModelLoader,
  LlmModelStopper
} from "./modules/llm/llmModelCapabilities"

declare module "fastify" {
  /** Fastify application services installed by the singleton-services plugin. */
  interface FastifyInstance {
    /** Application-scoped service for OpenAI-compatible chat completion streams. */
    chatService: ChatService
    /** Application-scoped model inventory and lifecycle capabilities. */
    llmService: LlmModelInventory & LlmModelLoader & LlmModelStopper
    /** Application-scoped service for synchronous conversation persistence. */
    conversationService: ConversationService
  }
}
