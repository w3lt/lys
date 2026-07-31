/// <reference types="fastify" />

import ChatService from "./di/services/chatService"
import LlmService from "./di/services/llmService"

declare module "fastify" {
  interface FastifyInstance {
    chatService: ChatService
    llmService: LlmService
  }
}
