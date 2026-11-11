import {
  conversationUserMessageSchema,
  type ConversationUserMessage
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type { TurnMcpTool } from "../mcp/mcpServerRegistry"
import type { TurnBuiltInTool } from "../tool/builtIn/builtInTool"
import type Agent from "./agent"
import type { AgentTurn } from "./agent"
import type {
  ReportToolSearchFailure,
  ToolSearch,
  ToolSearchOutcome
} from "./findToolsTool"
import MemoryReply from "./memoryReply"
import ToolCatalog from "./toolCatalog"
import { buildToolKeeperTools } from "./toolKeeperTools"
import { NO_UNOFFERED_TOOLS } from "./unofferedTools"

/**
 * Number of rounds, from round 0, whose tool calls one search keeps; a call
 * of a later round ends the search with the tools recommended so far.
 */
export const MAXIMUM_TOOL_KEEPER_ROUND_COUNT = 6

/** Outcome of a search that ended without finding. */
const FAILED_SEARCH: ToolSearchOutcome = Object.freeze({ status: "failed" })

/** Transcript before a search's message: none. */
const NO_HISTORY = Object.freeze([])

/** Sources of a search's conversation: none. */
const NO_SOURCES = Object.freeze([])

/** Client tools of a search: none. */
const NO_CLIENT_TOOLS = Object.freeze([])

/** Built-in tools of a search besides Armitage's own: none. */
const NO_BUILT_IN_TOOLS: readonly TurnBuiltInTool[] = Object.freeze([])

/** MCP tools of a search: none. */
const NO_MCP_TOOLS: readonly TurnMcpTool[] = Object.freeze([])

/**
 * Has Armitage, the tool keeper, find the tools of an asking turn that fit
 * a task, on a reply that is never stored or shown.
 *
 * @param armitage - Armitage's live agent, which answers the search as one
 * of its requests, on the asking reply's conversation, taking one of its
 * request slots.
 * @param search - The task, the asking turn's tools, the model and its
 * controls, the asking reply's cancellation, and the receiver of the
 * failure that ends a search without finding; borrowed until the returned
 * promise settles.
 * @returns `found` with the tools Armitage recommended, in the order
 * recommended, when its reply completed or ended at the round limit;
 * `failed` when the reply was refused, failed, or was reported as cancelled
 * by the model, after reporting why.
 * @throws The abort reason once the asking reply's signal aborted, whatever
 * Armitage found by then, reporting nothing.
 * @remarks Armitage reads only the asking turn's definitions, through its
 * own two tools, which run at once without the person being asked; it runs
 * none of the asking turn's tools. Its reply starts from Armitage's own
 * system prompt and a user message holding the task, without history,
 * images, or the asking reply's other tools.
 */
export async function runToolKeeperSearch(
  armitage: Agent,
  search: ToolSearch
): Promise<ToolSearchOutcome> {
  const catalog = new ToolCatalog(search.tools)
  let failed = false
  const reportSearchFailure = (failure: unknown): void => {
    failed = true
    search.reportFailure(failure)
  }
  await armitage.createReply(
    buildSearchTurn(search, catalog, reportSearchFailure)
  )
  search.abortSignal.throwIfAborted()
  if (failed) return FAILED_SEARCH
  const toolNames = catalog.listRecommendedToolNames()
  return Object.freeze({ status: "found", toolNames })
}

/**
 * Builds the turn Armitage answers for one search.
 *
 * @param search - The search.
 * @param catalog - The asking turn's tools and the search's
 * recommendations.
 * @param reportFailure - Receives the failure that ended the search
 * without finding.
 * @returns A turn on a new in-memory reply that keeps the tool calls of
 * {@link MAXIMUM_TOOL_KEEPER_ROUND_COUNT} rounds, offering Armitage's two
 * tools and nothing else, so it is never routed; a cancellation is reported
 * only when the asking reply was not stopped.
 */
function buildSearchTurn(
  search: ToolSearch,
  catalog: ToolCatalog,
  reportFailure: ReportToolSearchFailure
): AgentTurn {
  const reply = new MemoryReply(MAXIMUM_TOOL_KEEPER_ROUND_COUNT)
  const userMessage = buildSearchMessage(search.task)
  return {
    conversationId: search.conversationId,
    requestId: uuidv7(),
    history: NO_HISTORY,
    sources: NO_SOURCES,
    userMessage,
    canSeeImages: false,
    findAttachmentImage: rejectAttachmentImageRead,
    model: search.model,
    trainedForToolUse: true,
    generationOptions: search.generationOptions,
    directTools: buildToolKeeperTools(catalog),
    clientTools: NO_CLIENT_TOOLS,
    builtInTools: NO_BUILT_IN_TOOLS,
    mcpTools: NO_MCP_TOOLS,
    unofferedTools: NO_UNOFFERED_TOOLS,
    abortSignal: search.abortSignal,
    createReplyPart: (draft) => reply.createReplyPart(draft),
    updateReplyPartContent: (partId, content) =>
      reply.updateReplyPartContent(partId, content),
    updateReplyToolCall: (toolCallId, change) =>
      reply.updateReplyToolCall(toolCallId, change),
    updateAssistantMessageState: (completion) =>
      reply.updateAssistantMessageState(completion),
    findReplyStatus: () => reply.findReplyStatus(),
    sendEvent: dropSearchEvent,
    sendClientToolCall: rejectClientToolCall,
    toolCallPolicy: search.toolCallPolicy,
    createToolCallGate: rejectToolCallGate,
    reportReplyCancellation: (failure) => {
      if (!search.abortSignal.aborted) reportFailure(failure)
    },
    reportReplyRefusal: reportFailure,
    reportReplyFailure: reportFailure,
    reportToolSearchFailure: reportFailure
  }
}

/**
 * Builds the user message a search sends Armitage.
 *
 * @param task - Trimmed, non-empty task of the search.
 * @returns A new validated message holding the task, without attachments.
 * @throws If the message breaks the conversation contract.
 */
function buildSearchMessage(task: string): ConversationUserMessage {
  return conversationUserMessageSchema.parse({
    id: uuidv7(),
    createdAt: new Date().toISOString(),
    role: "user",
    content: task,
    attachments: []
  })
}

/**
 * Drops one event of a search's reply.
 *
 * @remarks A search's reply is never stored or shown, so its events have no
 * follower; the asking reply shows the search as its `find_tools` call.
 */
function dropSearchEvent(): void {
  // Nothing follows a search's reply.
}

/**
 * Refuses an image read; a search sends no image, so a read is a defect.
 *
 * @returns A promise that rejects, which fails the search.
 */
function rejectAttachmentImageRead(): Promise<never> {
  return Promise.reject(new Error("A tool search reads no attachment image"))
}

/**
 * Refuses a client tool call; a search offers no client tool, so a call is
 * a defect.
 *
 * @returns A promise that rejects, which fails the search.
 */
function rejectClientToolCall(): Promise<never> {
  return Promise.reject(new Error("A tool search offers no client tool"))
}

/**
 * Refuses an approval gate; Armitage's tools run without approval, so a
 * gate is a defect.
 *
 * @returns A promise that rejects, which fails the search.
 */
function rejectToolCallGate(): Promise<never> {
  return Promise.reject(new Error("A tool search asks the person nothing"))
}
