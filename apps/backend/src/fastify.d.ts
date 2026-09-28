/// <reference types="fastify" />

import type ChatService from "./di/services/chatService"
import type ConversationService from "./di/services/conversationService"
import type LlmRuntimeService from "./di/services/llmRuntimeService"
import type LlmService from "./di/services/llmService"

declare module "fastify" {
  /** Fastify application services installed by the singleton-services plugin. */
  interface FastifyInstance {
    /** Application-scoped service for OpenAI-compatible chat completion streams. */
    chatService: ChatService
    /** Application-scoped model inventory, lifecycle, and health policy. */
    llmService: LlmService
    /** Application-scoped LLM runtime connection and model-operation queue. */
    llmRuntimeService: LlmRuntimeService
    /** Application-scoped service for synchronous conversation persistence. */
    conversationService: ConversationService
  }
}
