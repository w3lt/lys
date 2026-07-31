/// <reference types="fastify" />

import ChatService from "./di/services/chatService"
import LlmService from "./di/services/llmService"

declare module "fastify" {
  /** Fastify application services installed by the singleton-services plugin. */
  interface FastifyInstance {
    /** Application-scoped service for OpenAI-compatible chat completion streams. */
    chatService: ChatService
    /** Application-scoped service for LM Studio model lifecycle operations. */
    llmService: LlmService
  }
}
