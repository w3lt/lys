/// <reference types="fastify" />

import type AgentService from "./modules/agent/agentService"
import type ChatService from "./modules/chat/chatService"
import type StoredConversationHistoryEditor from "./modules/conversation/historyEditor"
import type StoredConversationHistoryReader from "./modules/conversation/historyReader"
import type StoredConversationTurns from "./modules/conversation/turns"
import type LlmRuntimeService from "./modules/llm/llmRuntimeService"
import type LlmService from "./modules/llm/llmService"
import type { BuiltInToolEntry } from "./modules/tool/builtIn/builtInTool"

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
    conversationTurns: StoredConversationTurns
    /** Application-scoped reading and search of conversation history. */
    conversationHistoryReader: StoredConversationHistoryReader
    /** Application-scoped renaming and deletion of stored conversations. */
    conversationHistoryEditor: StoredConversationHistoryEditor
    /** Application-scoped agent definitions and the agents that answer chats. */
    agentService: AgentService
    /** Every tool the backend runs, in the order Settings lists them. */
    builtInTools: readonly BuiltInToolEntry[]
  }
}
