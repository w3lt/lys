import type {
  ConversationSource,
  ReplyPart,
  ToolCallReplyPart
} from "@lys/share"
import type {
  CreateReplyPartInput,
  ReplyPartRecordWriter,
  UpdateReplyPartContentInput,
  UpdateReplyToolCallInput
} from "../../../modules/conversation/records"
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

/** Column values of one stored piece that differ by kind. */
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
  /** JSON array of source numbers, or null when the piece shows none. */
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
 * Stores one source in the call's conversation unless its URL is stored
 * there already.
 */
const CREATE_CONVERSATION_SOURCE_SQL = `INSERT INTO conversation_sources
  (conversation_id, number, url, title)
  SELECT conversation_id, ?, ?, ? FROM conversation_messages WHERE id = ?
  ON CONFLICT (conversation_id, url) DO NOTHING`

/** Reads one stored tool call. */
const FIND_TOOL_CALL_SQL = `SELECT id, role, round, content, status,
  tool_name AS toolName, tool_arguments AS toolArguments,
  source_numbers AS sourceNumbers, created_at AS createdAt, updated_at AS updatedAt
  FROM conversation_messages WHERE id = ? AND role = 'tool_call'`

/**
 * Encodes a list of source numbers for storage.
 *
 * @param sourceNumbers - Numbers a piece shows.
 * @returns A JSON array, or null when the list is empty.
 */
function formatSourceNumbers(sourceNumbers: readonly number[]): string | null {
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
        content: "result" in part ? part.result : "",
        status: part.status,
        toolName: part.toolName,
        toolArguments: part.argumentText,
        sourceNumbers: formatSourceNumbers(part.sourceNumbers)
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
        formatSourceNumbers(sources.map((source) => source.number)),
        input.updatedAt,
        input.toolCallId,
        input.assistantMessageId,
        getPreviousToolCallStatus(change),
        input.assistantMessageId
      ).changes === 1
  if (!isUpdated) return false
  const createSource = statements.getStatement(CREATE_CONVERSATION_SOURCE_SQL)
  for (const source of sources)
    createSource.run(source.number, source.url, source.title, input.toolCallId)
  return true
}

/**
 * Stores one change of a call: running, or its result.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param input - Reply, call, change, and part timestamp.
 * @returns True when stored; false when the reply or the call's state refused
 * it.
 */
function updateToolCall(
  statements: DatabaseStatementCompiler,
  input: UpdateReplyToolCallInput
): boolean {
  const { change } = input
  if (change.status !== "running")
    return updateToolCallResult(statements, input, change)
  return (
    statements
      .getStatement(UPDATE_REPLY_TOOL_CALL_TO_RUNNING_SQL)
      .run(
        input.updatedAt,
        input.toolCallId,
        input.assistantMessageId,
        input.assistantMessageId
      ).changes === 1
  )
}

/**
 * Borrows the shared database's write transactions to store the parts of
 * streaming replies and the sources their calls read.
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
   * @param input - Interface-defined reply and part.
   * @returns The interface-defined storage outcome.
   * @throws The interface-defined closed and write failures.
   */
  public createReplyPart(input: CreateReplyPartInput): boolean {
    const { part } = input
    const columns = buildReplyPartColumns(part)
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
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
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
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
   * Implements {@link ReplyPartRecordWriter.updateReplyToolCall}.
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
