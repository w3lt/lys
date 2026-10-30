/// <reference types="fastify" />

import type AgentRuntimeService from "./modules/agent/agentRuntimeService"
import type AgentService from "./modules/agent/agentService"
import type AttachmentFileStore from "./modules/attachment/attachmentFileStore"
import type ChatService from "./modules/chat/chatService"
import type StoredConversationHistoryEditor from "./modules/conversation/historyEditor"
import type StoredConversationHistoryReader from "./modules/conversation/historyReader"
import type StoredReplyParts from "./modules/conversation/replyParts"
import type StoredConversationTurns from "./modules/conversation/turns"
import type LlmRuntimeService from "./modules/llm/llmRuntimeService"
import type LlmService from "./modules/llm/llmService"
import type McpServerProcessGroups from "./modules/mcp/mcpServerProcessGroups"
import type McpServerRegistry from "./modules/mcp/mcpServerRegistry"
import type { BuiltInToolEntry } from "./modules/tool/builtIn/builtInTool"
import type WebSearchToolProvider from "./modules/tool/builtIn/web/webSearchToolProvider"
import type ToolApprovalService from "./modules/toolApproval/toolApprovalService"

declare module "fastify" {
  /** Fastify application services installed by the singleton-services plugin. */
  interface FastifyInstance {
    /** Application-scoped service for OpenAI-compatible chat completion streams. */
    chatService: ChatService
    /** Application-scoped model inventory, lifecycle, and health policy. */
    llmService: LlmService
    /** Application-scoped LLM runtime connection and model-operation queue. */
    llmRuntimeService: LlmRuntimeService
    /** Application-scoped persistence of chat turns and their replies' states. */
    conversationTurns: StoredConversationTurns
    /** Application-scoped persistence of reply parts and the sources they read. */
    replyParts: StoredReplyParts
    /** Application-scoped reading and search of conversation history. */
    conversationHistoryReader: StoredConversationHistoryReader
    /** Application-scoped renaming and deletion of stored conversations. */
    conversationHistoryEditor: StoredConversationHistoryEditor
    /** Application-scoped built-in agents and stored agent definitions. */
    agentService: AgentService
    /**
     * Application-scoped live agents that answer chats, and what agents may
     * learn about themselves and each other.
     */
    agentRuntimeService: AgentRuntimeService
    /** Every tool the backend runs, in the order Settings lists them. */
    builtInTools: readonly BuiltInToolEntry[]
    /**
     * Application-scoped lookup of the web search tool and checks of the
     * saved Tavily key.
     */
    webSearchToolProvider: WebSearchToolProvider
    /**
     * Application-scoped approval gateway that decides, from the saved Just
     * run choices, which tool calls ask the person first.
     */
    toolApprovalService: ToolApprovalService
    /**
     * Application-scoped connections to the MCP servers the settings file
     * names, and their tools.
     */
    mcpServerRegistry: McpServerRegistry
    /**
     * Application-scoped identifiers of the process groups the stdio MCP
     * servers run in, which the backend ends at once when it exits.
     */
    mcpServerProcessGroups: McpServerProcessGroups
    /**
     * Application-scoped attachment files of every conversation, under the
     * attachments directory.
     */
    attachmentFileStore: AttachmentFileStore
  }
}
