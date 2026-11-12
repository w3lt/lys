import {
  isAnsweredToolCall,
  type ConversationSource,
  type ReplyPart,
  type ToolCallReplyPart
} from "@lys/share"
import type {
  CreateReplyPartInput,
  ReplyPartRecordWriter,
  UpdateReplyPartContentInput,
  UpdateReplyToolCallInput
} from "../../../modules/conversation/records"
import type { ToolCallDecisionRecord } from "../../../modules/toolApproval/toolCallDecisionRecord"
import type {
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../databaseTransactions"
import { parseStoredReplyPart } from "./findConversation"

/** A change of a stored call that gives it its result. */
type ToolCallResultChange = Exclude<
  UpdateReplyToolCallInput["change"],
  { status: "running" }
>

/** Column values of one stored piece that differ by kind and state. */
type ReplyPartColumns = Readonly<{
  /** Stored role of the piece. */
  role: "reasoning" | "text" | "tool_call"
  /** Fragment text, or a call's result text; empty while a call has none. */
  content: string
  /** Call state, or null for reasoning and text. */
  status: string | null
  /** Called tool name, or null for reasoning and text. */
  toolName: string | null
  /** Model's argument text, or null for reasoning and text. */
  toolArguments: string | null
  /**
   * JSON array of a succeeded call's source numbers, or null when the piece
   * shows none.
   */
  sourceNumbers: string | null
}>

/**
 * Stores one piece after its reply's last piece, only while the reply is
 * streaming; the piece takes the reply's conversation.
 */
const CREATE_REPLY_PART_SQL = `INSERT INTO conversation_messages
  (id, conversation_id, role, reply_id, position, round, content, status,
    tool_name, tool_arguments, source_numbers, created_at, updated_at)
  SELECT ?, r.conversation_id, ?, r.id,
    (SELECT coalesce(max(p.position), -1) + 1 FROM conversation_messages p
      WHERE p.reply_id = r.id),
    ?, ?, ?, ?, ?, ?, ?, ?
  FROM conversation_messages r
  WHERE r.id = ? AND r.role = 'assistant' AND r.status = 'streaming'`

/** Appends a fragment to a reasoning or text piece of a streaming reply. */
const UPDATE_REPLY_PART_CONTENT_SQL = `UPDATE conversation_messages
  SET content = content || ?, updated_at = ?
  WHERE id = ? AND reply_id = ? AND role IN ('reasoning', 'text')
    AND EXISTS (SELECT 1 FROM conversation_messages r
      WHERE r.id = ? AND r.role = 'assistant' AND r.status = 'streaming')`

/** Moves a waiting call of a streaming reply to running. */
const UPDATE_REPLY_TOOL_CALL_TO_RUNNING_SQL = `UPDATE conversation_messages
  SET status = 'running', updated_at = ?
  WHERE id = ? AND reply_id = ? AND role = 'tool_call'
    AND status = 'awaiting-approval'
    AND EXISTS (SELECT 1 FROM conversation_messages r
      WHERE r.id = ? AND r.role = 'assistant' AND r.status = 'streaming')`

/**
 * Ends a call of a streaming reply with its result, from the one state the
 * new status follows.
 */
const UPDATE_REPLY_TOOL_CALL_RESULT_SQL = `UPDATE conversation_messages
  SET status = ?, content = ?, source_numbers = ?, updated_at = ?
  WHERE id = ? AND reply_id = ? AND role = 'tool_call' AND status = ?
    AND EXISTS (SELECT 1 FROM conversation_messages r
      WHERE r.id = ? AND r.role = 'assistant' AND r.status = 'streaming')`

/**
 * Stores one source in the call's conversation unless the conversation
 * already stores the same number for the same URL; bound to the number, URL,
 * title, and call, then the number and URL again. Any other conflict, the
 * number stored for another URL or the URL under another number, fails the
 * insert.
 */
const CREATE_CONVERSATION_SOURCE_SQL = `INSERT INTO conversation_sources
  (conversation_id, number, url, title)
  SELECT m.conversation_id, ?, ?, ? FROM conversation_messages m
  WHERE m.id = ? AND NOT EXISTS (SELECT 1 FROM conversation_sources s
    WHERE s.conversation_id = m.conversation_id AND s.number = ? AND s.url = ?)`

/**
 * Stores the decision record of one tool call just stored: its conversation,
 * the conversation's agent, its tool, and its status and times come from the
 * call's row; bound to the policy's effect and reason and the approval mode,
 * then the call.
 */
const CREATE_TOOL_CALL_DECISION_SQL = `INSERT INTO tool_call_decisions
  (call_id, conversation_id, agent_code, tool_name, policy_effect,
    policy_reason, approval_mode, outcome, created_at, updated_at)
  SELECT p.id, p.conversation_id, c.agent_code, p.tool_name, ?, ?, ?,
    p.status, p.created_at, p.updated_at
  FROM conversation_messages p JOIN conversations c ON c.id = p.conversation_id
  WHERE p.id = ? AND p.role = 'tool_call'`

/**
 * Stores the answer that moved a waiting call on in the call's decision
 * record, if it has one; bound to the answer, then the call.
 */
const UPDATE_TOOL_CALL_DECISION_ANSWER_SQL = `UPDATE tool_call_decisions
  SET answer = ? WHERE call_id = ?`

/** Column values of one decision record that the backend decides. */
type ToolCallDecisionColumns = Readonly<{
  /**
   * `allow`, `require-approval`, or `deny`; null when the policy was not
   * asked.
   */
  policyEffect: string | null
  /** Rule behind `require-approval` or `deny`; null otherwise. */
  policyReason: string | null
  /** `ask-me` or `just-run`; null when the call never reached the gate. */
  approvalMode: string | null
}>

/** Reads one stored tool call. */
const FIND_TOOL_CALL_SQL = `SELECT id, role, round, content, status,
  tool_name AS toolName, tool_arguments AS toolArguments,
  source_numbers AS sourceNumbers, created_at AS createdAt, updated_at AS updatedAt
  FROM conversation_messages WHERE id = ? AND role = 'tool_call'`

/**
 * Builds the stored form of a succeeded call's source numbers.
 *
 * @param sourceNumbers - Numbers the call's result shows.
 * @returns The `source_numbers` column value: a JSON array, or null when the
 * list is empty.
 */
function buildSourceNumbersColumn(
  sourceNumbers: readonly number[]
): string | null {
  return sourceNumbers.length === 0 ? null : JSON.stringify(sourceNumbers)
}

/**
 * Selects the stored columns of one part.
 *
 * @param part - Valid part.
 * @returns The values its kind stores.
 */
function buildReplyPartColumns(part: ReplyPart): ReplyPartColumns {
  switch (part.kind) {
    case "reasoning":
    case "text":
      return {
        role: part.kind,
        content: part.content,
        status: null,
        toolName: null,
        toolArguments: null,
        sourceNumbers: null
      }
    case "tool-call":
      return {
        role: "tool_call",
        content: isAnsweredToolCall(part) ? part.result : "",
        status: part.status,
        toolName: part.toolName,
        toolArguments: part.argumentText,
        sourceNumbers:
          part.status === "succeeded"
            ? buildSourceNumbersColumn(part.sourceNumbers)
            : null
      }
  }
}

/**
 * Selects the call state a change follows.
 *
 * @param change - Change of a call's result.
 * @returns `awaiting-approval` for a rejection; `running` for an outcome of
 * the run.
 */
function getPreviousToolCallStatus(
  change: ToolCallResultChange
): "awaiting-approval" | "running" {
  return change.status === "rejected" ? "awaiting-approval" : "running"
}

/**
 * Selects the sources a change stores.
 *
 * @param change - Change of a call's result.
 * @returns A succeeded call's sources; none for any other outcome.
 */
function listChangeSources(
  change: ToolCallResultChange
): readonly ConversationSource[] {
  return change.status === "succeeded" ? change.sources : []
}

/**
 * Reads one stored tool call as its part.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param toolCallId - Identity of a stored call.
 * @returns The validated call.
 * @throws If the call is not stored or violates the part contract.
 */
function getToolCallPart(
  statements: DatabaseStatementCompiler,
  toolCallId: string
): ToolCallReplyPart {
  const row = statements.getStatement(FIND_TOOL_CALL_SQL).get(toolCallId)
  if (row === undefined)
    throw new Error(`Tool call ${toolCallId} is not stored`)
  const part = parseStoredReplyPart(row)
  if (part.kind !== "tool-call")
    throw new Error(`Part ${toolCallId} is not a tool call`)
  return part
}

/**
 * Stores one change of a call's result and the sources it brings.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param input - Reply, call, change, and part timestamp.
 * @param change - The input's result change.
 * @returns True when the call was in the state the change follows and the
 * reply is streaming; false otherwise, which changes nothing.
 * @throws If the conversation stores a source's number for another URL or
 * its URL under another number, or the write fails; the caller's transaction
 * then rolls back.
 */
function updateToolCallResult(
  statements: DatabaseStatementCompiler,
  input: UpdateReplyToolCallInput,
  change: ToolCallResultChange
): boolean {
  const sources = listChangeSources(change)
  const isUpdated =
    statements
      .getStatement(UPDATE_REPLY_TOOL_CALL_RESULT_SQL)
      .run(
        change.status,
        change.result,
        buildSourceNumbersColumn(sources.map((source) => source.number)),
        input.updatedAt,
        input.toolCallId,
        input.assistantMessageId,
        getPreviousToolCallStatus(change),
        input.assistantMessageId
      ).changes === 1
  if (!isUpdated) return false
  if (change.status === "rejected")
    updateToolCallDecisionAnswer(statements, input.toolCallId, change.reason)
  const createSource = statements.getStatement(CREATE_CONVERSATION_SOURCE_SQL)
  for (const source of sources)
    createSource.run(
      source.number,
      source.url,
      source.title,
      input.toolCallId,
      source.number,
      source.url
    )
  return true
}

/**
 * Builds the column values of one call's decision record.
 *
 * @param decision - How the call was decided.
 * @returns The policy's effect and reason and the approval mode, null where
 * the decision has none.
 */
function buildToolCallDecisionColumns(
  decision: ToolCallDecisionRecord
): ToolCallDecisionColumns {
  const { policyDecision } = decision
  return {
    policyEffect: policyDecision?.effect ?? null,
    policyReason:
      policyDecision === undefined || policyDecision.effect === "allow"
        ? null
        : policyDecision.reason,
    approvalMode: decision.approvalMode ?? null
  }
}

/**
 * Stores the decision record of one tool call just stored.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param toolCallId - UUIDv7 of the call, stored in this transaction.
 * @param decision - How the call was decided.
 * @throws If the call is not stored, a column breaks the table's rules, or
 * the write fails; the caller's transaction then rolls back.
 */
function createToolCallDecision(
  statements: DatabaseStatementCompiler,
  toolCallId: string,
  decision: ToolCallDecisionRecord
): void {
  const columns = buildToolCallDecisionColumns(decision)
  const isCreated =
    statements
      .getStatement(CREATE_TOOL_CALL_DECISION_SQL)
      .run(
        columns.policyEffect,
        columns.policyReason,
        columns.approvalMode,
        toolCallId
      ).changes === 1
  if (!isCreated)
    throw new Error(`Tool call ${toolCallId} is not stored for its decision`)
}

/**
 * Stores the answer that moved a waiting call on in its decision record.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param toolCallId - UUIDv7 of the call, changed in this transaction.
 * @param answer - `allowed`, or the rejection's reason.
 * @remarks A call stored before the schema had decision records has none,
 * and its answer is not recorded; every call stored since gets its record in
 * the write that stores it.
 * @throws If the write fails; the caller's transaction then rolls back.
 */
function updateToolCallDecisionAnswer(
  statements: DatabaseStatementCompiler,
  toolCallId: string,
  answer: "allowed" | "declined" | "showFailed"
): void {
  statements
    .getStatement(UPDATE_TOOL_CALL_DECISION_ANSWER_SQL)
    .run(answer, toolCallId)
}

/**
 * Stores one change of a call: running, or its result.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param input - Reply, call, change, and part timestamp.
 * @returns True when stored; false when the reply or the call's state refused
 * it.
 * @throws If the conversation stores a source's number for another URL or
 * its URL under another number, or the write fails; the caller's transaction
 * then rolls back.
 */
function updateToolCall(
  statements: DatabaseStatementCompiler,
  input: UpdateReplyToolCallInput
): boolean {
  const { change } = input
  if (change.status !== "running")
    return updateToolCallResult(statements, input, change)
  const isUpdated =
    statements
      .getStatement(UPDATE_REPLY_TOOL_CALL_TO_RUNNING_SQL)
      .run(
        input.updatedAt,
        input.toolCallId,
        input.assistantMessageId,
        input.assistantMessageId
      ).changes === 1
  if (isUpdated)
    updateToolCallDecisionAnswer(statements, input.toolCallId, "allowed")
  return isUpdated
}

/**
 * Stores one piece after its reply's last piece and, for a tool call, its
 * decision record.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param input - Reply, the complete part, and a tool call's decision.
 * @returns True when stored; false when the reply is not streaming or not
 * stored, which changes nothing.
 * @throws If a tool call comes without its decision or another part with
 * one, before anything is written; or if the write fails, including when the
 * part's identity is already stored; the caller's transaction then rolls
 * back.
 */
function createStoredReplyPart(
  statements: DatabaseStatementCompiler,
  input: CreateReplyPartInput
): boolean {
  const { part, toolCallDecision } = input
  if ((part.kind === "tool-call") !== (toolCallDecision !== undefined))
    throw new Error(
      "A tool call is stored with its decision, and no other part with one"
    )
  const columns = buildReplyPartColumns(part)
  const isCreated =
    statements
      .getStatement(CREATE_REPLY_PART_SQL)
      .run(
        part.id,
        columns.role,
        part.round,
        columns.content,
        columns.status,
        columns.toolName,
        columns.toolArguments,
        columns.sourceNumbers,
        part.createdAt,
        part.updatedAt,
        input.assistantMessageId
      ).changes === 1
  if (isCreated && toolCallDecision !== undefined)
    createToolCallDecision(statements, part.id, toolCallDecision)
  return isCreated
}

/**
 * Appends a fragment to a reasoning or text piece of a streaming reply.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param input - Reply, part, fragment, and part timestamp.
 * @returns True when appended; false when the reply is not streaming, or the
 * part is not one of its reasoning or text pieces, which changes nothing.
 * @throws If the write fails; the caller's transaction then rolls back.
 */
function updateStoredReplyPartContent(
  statements: DatabaseStatementCompiler,
  input: UpdateReplyPartContentInput
): boolean {
  return (
    statements
      .getStatement(UPDATE_REPLY_PART_CONTENT_SQL)
      .run(
        input.content,
        input.updatedAt,
        input.partId,
        input.assistantMessageId,
        input.assistantMessageId
      ).changes === 1
  )
}

/**
 * Borrows the shared database's write transactions to store the parts of
 * streaming replies, the sources their calls read, and each call's decision
 * record.
 *
 * @remarks Owns no resource: the database's owner closes the connection,
 * after which every operation fails with `Database is closed`. Each call is
 * one write transaction that commits before it returns. Concurrency model:
 * single-owner, synchronous on the backend's event loop. Implements
 * {@link ReplyPartRecordWriter}.
 */
export default class SqliteReplyPartRecordWriter implements ReplyPartRecordWriter {
  /** Borrowed write transactions for every part change. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed write access without performing database work.
   * @param databaseWriter - Write transactions lent by the database owner.
   */
  public constructor(databaseWriter: DatabaseWriter) {
    this.#databaseWriter = databaseWriter
  }

  /**
   * Implements {@link ReplyPartRecordWriter.createReplyPart}; the schema's
   * message-insert trigger moves the activity time forward.
   * @param input - Interface-defined reply, part, and tool call decision.
   * @returns The interface-defined storage outcome.
   * @throws The interface-defined closed and write failures.
   */
  public createReplyPart(input: CreateReplyPartInput): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      createStoredReplyPart(statements, input)
    )
  }

  /**
   * Implements {@link ReplyPartRecordWriter.updateReplyPartContent}; the
   * schema's message-update trigger moves the activity time forward.
   * @param input - Interface-defined reply, part, fragment, and timestamp.
   * @returns The interface-defined append outcome.
   * @throws The interface-defined closed and write failures.
   */
  public updateReplyPartContent(input: UpdateReplyPartContentInput): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      updateStoredReplyPartContent(statements, input)
    )
  }

  /**
   * Implements {@link ReplyPartRecordWriter.updateReplyToolCall}; the
   * schema's decision trigger copies the call's new status into its record.
   * @param input - Interface-defined reply, call, change, and timestamp.
   * @returns The interface-defined stored call or absence.
   * @throws The interface-defined closed, write, and source failures.
   */
  public updateReplyToolCall(
    input: UpdateReplyToolCallInput
  ): ToolCallReplyPart | undefined {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      updateToolCall(statements, input)
        ? getToolCallPart(statements, input.toolCallId)
        : undefined
    )
  }
}
