import {
  conversationUserMessageSchema,
  type ConversationUserMessage,
  type ReplyPart,
  type ToolCallReplyPart
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type { ToolSearchCallRecordWriter } from "../conversation/records"
import type { TurnMcpTool } from "../mcp/mcpServerRegistry"
import type { TurnBuiltInTool } from "../tool/builtIn/builtInTool"
import type Agent from "./agent"
import type { AgentTurn } from "./agent"
import {
  FAILED_TOOL_SEARCH,
  type ReportToolSearchFailure,
  type ToolSearch,
  type ToolSearchOutcome
} from "./findToolsTool"
import MemoryReply from "./memoryReply"
import type { ReplyPartDraft, ReplyToolCallChange } from "./replyPartSequence"
import ToolCatalog from "./toolCatalog"
import { buildToolKeeperTools } from "./toolKeeperTools"
import { NO_UNOFFERED_TOOLS } from "./unofferedTools"

/**
 * Number of rounds, from round 0, whose tool calls one search keeps; a call
 * of a later round ends the search with the tools recommended so far.
 */
export const MAXIMUM_TOOL_KEEPER_ROUND_COUNT = 6

/** Where the tool calls of one search's reply are recorded. */
type SearchCallRecording = Readonly<{
  /** UUIDv7 of the stored `find_tools` call that runs the search. */
  searchCallId: string
  /** Code of the agent that answers the search. */
  agentCode: string
  /** Stores the decision records of the search's own tool calls. */
  records: ToolSearchCallRecordWriter
}>

/** What building the turn of one search needs. */
type SearchTurnInput = Readonly<{
  /** The search. */
  search: ToolSearch
  /** The asking turn's tools and the search's recommendations. */
  catalog: ToolCatalog
  /** Time the search started, as ISO 8601 text; the time of its message. */
  now: string
  /** Receives the failure that ended the search without finding. */
  reportFailure: ReportToolSearchFailure
  /** Where the reply's tool calls are recorded. */
  recording: SearchCallRecording
}>

/**
 * Has Armitage, the tool keeper, find the tools of an asking turn that fit
 * a task, on a reply that is never stored or shown.
 *
 * @param armitage - Armitage's live agent, which answers the search as one
 * of its requests, on the asking reply's conversation, taking one of its
 * request slots.
 * @param search - The task, the `find_tools` call that runs it, the asking
 * turn's tools, the model and its controls, the asking reply's
 * cancellation, and the receiver of the failure that ends a search without
 * finding; borrowed until the returned promise settles.
 * @param records - Stores the decision record of each tool call Armitage's
 * reply keeps; borrowed until the returned promise settles.
 * @returns `found` with the tools Armitage recommended, in the order
 * recommended, when its reply completed or ended at the round limit;
 * `failed` when the reply was refused, failed, or was reported as cancelled
 * by the model, after reporting why.
 * @throws The abort reason once the asking reply's signal aborted, whatever
 * Armitage found by then, reporting nothing.
 * @remarks Armitage reads only the asking turn's definitions, through its
 * own two tools, whose calls pass the search's tool call policy and then
 * run at once without the person being asked; it runs none of the asking
 * turn's tools. Each call its reply keeps is recorded, under the search's
 * `find_tools` call, before it can run, and its end once it ends; a call
 * that cannot be recorded because that `find_tools` call no longer runs is
 * refused and never runs, and a record that cannot be written fails the
 * search. Its reply starts from Armitage's own system prompt and a
 * user message holding the task, without history, images, or the asking
 * reply's other tools. The clock is read once, when the search starts, for
 * the time of that message.
 */
export async function runToolKeeperSearch(
  armitage: Agent,
  search: ToolSearch,
  records: ToolSearchCallRecordWriter
): Promise<ToolSearchOutcome> {
  const catalog = new ToolCatalog(search.tools)
  let failed = false
  /**
   * Handles the failure that ends the search without finding: marks the
   * search as failed, then passes the failure to the search's receiver.
   *
   * @param failure - The refusal, failure, or reported cancellation.
   */
  const handleSearchFailure = (failure: unknown): void => {
    failed = true
    search.reportFailure(failure)
  }
  const now = new Date().toISOString()
  await armitage.createReply(
    buildSearchTurn({
      search,
      catalog,
      now,
      reportFailure: handleSearchFailure,
      recording: {
        searchCallId: search.searchCallId,
        agentCode: armitage.code,
        records
      }
    })
  )
  search.abortSignal.throwIfAborted()
  if (failed) return FAILED_TOOL_SEARCH
  const toolNames = catalog.listRecommendedToolNames()
  return Object.freeze({ status: "found", toolNames })
}

/**
 * Builds the turn Armitage answers for one search.
 *
 * @param input - The search, its catalog, the time it started, the
 * receiver of the failure that ended it without finding, and where its
 * reply's tool calls are recorded.
 * @returns A turn on a new in-memory reply that keeps the tool calls of
 * {@link MAXIMUM_TOOL_KEEPER_ROUND_COUNT} rounds, each recorded as it is
 * kept and as it ends, offering Armitage's two tools and nothing else, so
 * it is never routed; a cancellation is reported only when the asking reply
 * was not stopped.
 * @throws If the search's message breaks the conversation contract.
 */
function buildSearchTurn(input: SearchTurnInput): AgentTurn {
  /** Transcript before a search's message: none. */
  const noHistory = Object.freeze([])
  /** Sources of a search's conversation: none. */
  const noSources = Object.freeze([])
  /** Client tools of a search: none. */
  const noClientTools = Object.freeze([])
  /** Built-in tools of a search besides Armitage's own: none. */
  const noBuiltInTools: readonly TurnBuiltInTool[] = Object.freeze([])
  /** MCP tools of a search: none. */
  const noMcpTools: readonly TurnMcpTool[] = Object.freeze([])

  const { search, reportFailure, recording } = input
  const reply = new MemoryReply(MAXIMUM_TOOL_KEEPER_ROUND_COUNT)
  const userMessage = buildSearchMessage(search.task, input.now)
  const directTools = buildToolKeeperTools(input.catalog)
  return {
    conversationId: search.conversationId,
    requestId: uuidv7(),
    history: noHistory,
    sources: noSources,
    userMessage,
    canSeeImages: false,
    findAttachmentImage: rejectAttachmentImageRead,
    model: search.model,
    trainedForToolUse: true,
    generationOptions: search.generationOptions,
    directTools,
    clientTools: noClientTools,
    builtInTools: noBuiltInTools,
    mcpTools: noMcpTools,
    unofferedTools: NO_UNOFFERED_TOOLS,
    abortSignal: search.abortSignal,
    createReplyPart: (draft) => createSearchReplyPart(recording, reply, draft),
    updateReplyPartContent: (partId, content) =>
      reply.updateReplyPartContent(partId, content),
    updateReplyToolCall: (toolCallId, change) =>
      updateSearchToolCall(recording.records, reply, toolCallId, change),
    updateAssistantMessageState: (completion) =>
      reply.updateAssistantMessageState(completion),
    findReplyStatus: () => reply.findReplyStatus(),
    sendEvent: handleSearchEvent,
    sendClientToolCall: rejectClientToolCall,
    toolCallPolicy: search.toolCallPolicy,
    createToolCallGate: rejectToolCallGate,
    reportReplyCancellation: (failure) =>
      handleSearchCancellation(search.abortSignal, reportFailure, failure),
    reportReplyRefusal: reportFailure,
    reportReplyFailure: reportFailure,
    reportToolSearchFailure: reportFailure
  }
}

/**
 * Keeps a new part of a search's reply and records a kept tool call.
 *
 * @param recording - Where the reply's tool calls are recorded.
 * @param reply - The search's reply.
 * @param draft - The part.
 * @returns The kept part; undefined when the reply refused it, or when it
 * is a call that could not be recorded because the search's `find_tools`
 * call no longer runs, which the agent then treats as refused, so the call
 * never runs.
 * @throws If the draft breaks the part contract or the record cannot be
 * written.
 */
function createSearchReplyPart(
  recording: SearchCallRecording,
  reply: MemoryReply,
  draft: ReplyPartDraft
): ReplyPart | undefined {
  const part = reply.createReplyPart(draft)
  if (part?.kind !== "tool-call" || draft.kind !== "tool-call") return part
  const isRecorded = recording.records.createToolSearchCallRecord({
    searchCallId: recording.searchCallId,
    agentCode: recording.agentCode,
    call: part,
    decision: draft.decision
  })
  return isRecorded ? part : undefined
}

/**
 * Keeps one change of a search's tool call and records how the call ended.
 *
 * @param records - Receiver of the search's call records.
 * @param reply - The search's reply.
 * @param toolCallId - UUIDv7 of the call.
 * @param change - The call's next state.
 * @returns The call as kept; undefined when the reply refused the change,
 * or when its record no longer runs because the search's `find_tools` call
 * stopped running.
 * @throws If the record cannot be written, including for a change no run
 * ends with, since a search's call never waits for the person.
 */
function updateSearchToolCall(
  records: ToolSearchCallRecordWriter,
  reply: MemoryReply,
  toolCallId: string,
  change: ReplyToolCallChange
): ToolCallReplyPart | undefined {
  const call = reply.updateReplyToolCall(toolCallId, change)
  if (call === undefined) return undefined
  return records.updateToolSearchCallOutcome(call) ? call : undefined
}

/**
 * Builds the user message a search sends Armitage.
 *
 * @param task - Trimmed, non-empty task of the search.
 * @param now - Time the search started, as ISO 8601 text; the message's
 * time.
 * @returns A new validated message holding the task, without attachments.
 * @throws If the message breaks the conversation contract.
 */
function buildSearchMessage(
  task: string,
  now: string
): ConversationUserMessage {
  return conversationUserMessageSchema.parse({
    id: uuidv7(),
    createdAt: now,
    role: "user",
    content: task,
    attachments: []
  })
}

/**
 * Handles a cancellation Armitage's reply reported.
 *
 * @param abortSignal - Cancellation of the asking reply.
 * @param reportFailure - Receives the failure that ended the search without
 * finding.
 * @param failure - The cancellation.
 * @remarks The cancellation is the search's failure only while the asking
 * reply was not stopped. After Stop the search ends with the abort reason,
 * so the receiver is not called.
 */
function handleSearchCancellation(
  abortSignal: AbortSignal,
  reportFailure: ReportToolSearchFailure,
  failure: unknown
): void {
  if (!abortSignal.aborted) reportFailure(failure)
}

/**
 * Handles one event of a search's reply by dropping it.
 *
 * @remarks A search's reply is never stored or shown, so its events have no
 * follower; the asking reply shows the search as its `find_tools` call.
 */
function handleSearchEvent(): void {
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
