/// <reference types="fastify" />

import type ChatService from "./di/services/chatService"
import type SqliteConversationHistoryEditor from "./infrastructure/database/conversations/historyEditor"
import type SqliteConversationHistoryReader from "./infrastructure/database/conversations/historyReader"
import type SqliteConversationTurns from "./infrastructure/database/conversations/turns"
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
    /** Application-scoped persistence of chat turns and their replies. */
    conversationTurns: SqliteConversationTurns
    /** Application-scoped reading and search of conversation history. */
    conversationHistoryReader: SqliteConversationHistoryReader
    /** Application-scoped renaming and deletion of stored conversations. */
    conversationHistoryEditor: SqliteConversationHistoryEditor
  }
}
