import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationImageAttachment,
  ConversationMetadata,
  ConversationUserMessage
} from "@lys/share"
import type {
  ConversationTurnOperation,
  ConversationTurnRecordWriter,
  ConversationTurnTransaction,
  UpdateAssistantMessageStateInput
} from "../../../modules/conversation/records"
import type {
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../databaseTransactions"
import { findConversation } from "./findConversation"

/**
 * Marks the waiting and running tool calls of one conversation's streaming
 * replies as interrupted; bound to the timestamp, then the conversation.
 */
const UPDATE_CONVERSATION_OPEN_TOOL_CALLS_TO_INTERRUPTED_SQL = `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
    WHERE role = 'tool_call' AND status IN ('awaiting-approval', 'running')
      AND reply_id IN (SELECT id FROM conversation_messages
        WHERE conversation_id = ? AND role = 'assistant' AND status = 'streaming')`

/**
 * Marks the waiting and running tool calls of every streaming reply as
 * interrupted, keeping each call's update time: the last time the call
 * changed while the reply worked.
 */
const UPDATE_ALL_OPEN_TOOL_CALLS_TO_INTERRUPTED_SQL = `UPDATE conversation_messages SET status = 'interrupted'
      WHERE role = 'tool_call' AND status IN ('awaiting-approval', 'running')
        AND reply_id IN (SELECT id FROM conversation_messages
          WHERE role = 'assistant' AND status = 'streaming')`

/**
 * Marks the waiting and running tool calls of one reply as interrupted;
 * bound to the timestamp, then the reply.
 */
const UPDATE_REPLY_OPEN_TOOL_CALLS_TO_INTERRUPTED_SQL = `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
      WHERE role = 'tool_call' AND status IN ('awaiting-approval', 'running')
        AND reply_id = ?`

/**
 * Stores one attachment under its message; bound to the conversation, the
 * message, and the attachment's columns.
 */
const INSERT_ATTACHMENT_SQL = `INSERT INTO conversation_attachments
    (conversation_id, message_id, number, name, kind, media_type, size_bytes, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

/**
 * Stores the attachments of one user message.
 *
 * @param statements - Compilation lent to the running write operation.
 * @param conversationId - Conversation of the message.
 * @param message - Message whose row is stored, with its attachments.
 * @remarks An image stores its media type and sides; a text file stores
 * NULL for them.
 */
function createMessageAttachments(
  statements: DatabaseStatementCompiler,
  conversationId: string,
  message: ConversationUserMessage
): void {
  const insertAttachment = statements.getStatement(INSERT_ATTACHMENT_SQL)
  for (const attachment of message.attachments) {
    const image: ConversationImageAttachment | undefined =
      attachment.kind === "image" ? attachment : undefined
    insertAttachment.run(
      conversationId,
      message.id,
      attachment.number,
      attachment.name,
      attachment.kind,
      image?.mediaType ?? null,
      attachment.sizeBytes,
      image?.width ?? null,
      image?.height ?? null
    )
  }
}

/**
 * Marks every streaming reply and its waiting and running tool calls as
 * interrupted.
 *
 * @param statements - Compilation lent to the running write operation.
 * @param updatedAt - Timestamp stored on every interrupted reply; each call
 * keeps its own update time.
 */
function updateAllStreamingRepliesToInterrupted(
  statements: DatabaseStatementCompiler,
  updatedAt: string
): void {
  statements.getStatement(UPDATE_ALL_OPEN_TOOL_CALLS_TO_INTERRUPTED_SQL).run()
  statements
    .getStatement(
      `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
      WHERE role = 'assistant' AND status = 'streaming'`
    )
    .run(updatedAt)
}

/**
 * Finalizes one streaming reply and, once it is final, marks its waiting and
 * running tool calls as interrupted.
 *
 * @param statements - Compilation lent to the running write operation.
 * @param input - Reply, terminal state, and timestamp.
 * @returns True when the reply was streaming and is now final.
 */
function updateStreamingReplyState(
  statements: DatabaseStatementCompiler,
  input: UpdateAssistantMessageStateInput
): boolean {
  const { assistantMessageId, completion, updatedAt } = input
  const finishReason =
    completion.status === "completed" ? completion.finishReason : null
  const isFinalized =
    statements
      .getStatement(
        `UPDATE conversation_messages SET status = ?, finish_reason = ?, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status = 'streaming'`
      )
      .run(completion.status, finishReason, updatedAt, assistantMessageId)
      .changes === 1
  if (isFinalized)
    statements
      .getStatement(UPDATE_REPLY_OPEN_TOOL_CALLS_TO_INTERRUPTED_SQL)
      .run(updatedAt, assistantMessageId)
  return isFinalized
}

/**
 * Reads and writes one turn's rows through the statement compiler lent to one
 * write operation.
 *
 * @remarks Invariant: it reaches the database only through the lent compiler,
 * so once that operation returns, every call fails with
 * `Database operation has ended` before running SQL. Resource ownership: the
 * compiler is borrowed for the operation's duration; nothing is released here.
 * Concurrency model: single-owner, confined to the running operation.
 * Implements {@link ConversationTurnTransaction}.
 */
class SqliteConversationTurnTransaction implements ConversationTurnTransaction {
  /** Statement compilation lent to the enclosing write operation. */
  readonly #statements: DatabaseStatementCompiler

  /**
   * Retains the compiler lent to the operation about to run.
   * @param statements - Compilation valid until the operation returns.
   */
  public constructor(statements: DatabaseStatementCompiler) {
    this.#statements = statements
  }

  /**
   * Implements
   * {@link ConversationTurnTransaction.updateStreamingAssistantMessagesToInterrupted}.
   * @param conversationId - Interface-defined conversation.
   * @param updatedAt - Interface-defined message timestamp.
   * @throws The interface-defined ended-transaction and write failures.
   */
  public updateStreamingAssistantMessagesToInterrupted(
    conversationId: string,
    updatedAt: string
  ): void {
    this.#statements
      .getStatement(UPDATE_CONVERSATION_OPEN_TOOL_CALLS_TO_INTERRUPTED_SQL)
      .run(updatedAt, conversationId)
    this.#statements
      .getStatement(
        `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
    WHERE conversation_id = ? AND role = 'assistant' AND status = 'streaming'`
      )
      .run(updatedAt, conversationId)
  }

  /**
   * Implements {@link ConversationTurnTransaction.createConversation}.
   * @param metadata - Interface-defined metadata.
   * @throws The interface-defined ended-transaction and write failures; a
   * stored identity fails the primary-key constraint.
   */
  public createConversation(metadata: ConversationMetadata): void {
    this.#statements
      .getStatement(
        `INSERT INTO conversations (id, title, agent_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        metadata.id,
        metadata.title,
        metadata.agentCode,
        metadata.createdAt,
        metadata.updatedAt
      )
  }

  /**
   * Implements {@link ConversationTurnTransaction.findConversation}.
   * @param conversationId - Interface-defined identity.
   * @returns The interface-defined conversation or absence.
   * @throws The interface-defined ended-transaction and validation failures.
   */
  public findConversation(conversationId: string): Conversation | undefined {
    return findConversation(this.#statements, conversationId)
  }

  /**
   * Implements {@link ConversationTurnTransaction.createUserMessage}, storing
   * each attachment of the message under it.
   * @param conversationId - Interface-defined conversation.
   * @param message - Interface-defined message with its attachments.
   * @throws The interface-defined failures; an absent conversation fails the
   * foreign-key constraint, a stored identity the primary-key constraint,
   * and a stored attachment number the unique constraint.
   */
  public createUserMessage(
    conversationId: string,
    message: ConversationUserMessage
  ): void {
    this.#statements
      .getStatement(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, 'user', ?, ?)`
      )
      .run(message.id, conversationId, message.content, message.createdAt)
    createMessageAttachments(this.#statements, conversationId, message)
  }

  /**
   * Implements {@link ConversationTurnTransaction.createAssistantMessage};
   * the reply row holds no text, which its parts hold.
   * @param conversationId - Interface-defined conversation.
   * @param message - Interface-defined message without parts.
   * @throws The interface-defined failures; an absent conversation fails the
   * foreign-key constraint and a stored identity the primary-key constraint.
   */
  public createAssistantMessage(
    conversationId: string,
    message: ConversationAssistantMessage
  ): void {
    this.#statements
      .getStatement(
        `INSERT INTO conversation_messages
    (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
    VALUES (?, ?, 'assistant', ?, '', ?, ?, ?, ?)`
      )
      .run(
        message.id,
        conversationId,
        message.model,
        message.status,
        message.finishReason,
        message.createdAt,
        message.updatedAt
      )
  }
}

/**
 * Borrows the shared database's write transactions to persist chat turns and
 * their reply lifecycle.
 *
 * @remarks Owns no resource: the database's owner closes the connection, after
 * which every operation fails with `Database is closed`. Each call is one write
 * transaction that commits before it returns. Concurrency model: single-owner,
 * synchronous on the backend's event loop. Implements
 * {@link ConversationTurnRecordWriter}.
 */
export default class SqliteConversationTurnRecordWriter implements ConversationTurnRecordWriter {
  /** Borrowed write transactions for every turn change. */
  readonly #databaseWriter: DatabaseWriter

  /**
   * Retains borrowed write access without performing database work.
   * @param databaseWriter - Write transactions lent by the database owner.
   */
  public constructor(databaseWriter: DatabaseWriter) {
    this.#databaseWriter = databaseWriter
  }

  /**
   * Implements {@link ConversationTurnRecordWriter.handleConversationTurnWriteRequest}
   * by lending the operation a transaction over the write's statement
   * compiler.
   * @typeParam Result - Interface-defined operation result.
   * @param operation - Interface-defined synchronous work.
   * @returns The interface-defined result after the commit.
   * @throws The interface-defined operation, commit, asynchronous-operation,
   * closed, nested-call, begin, and rollback failures.
   */
  public handleConversationTurnWriteRequest<Result>(
    operation: ConversationTurnOperation<Result>
  ): Result {
    return this.#databaseWriter.handleDatabaseWriteRequest<Result>(
      (statements) =>
        operation(new SqliteConversationTurnTransaction(statements))
    )
  }

  /**
   * Implements
   * {@link ConversationTurnRecordWriter.updateAllStreamingAssistantMessagesToInterrupted}.
   * @param updatedAt - Interface-defined message timestamp.
   * @throws The interface-defined closed and write failures.
   */
  public updateAllStreamingAssistantMessagesToInterrupted(
    updatedAt: string
  ): void {
    this.#databaseWriter.handleDatabaseWriteRequest((statements) => {
      updateAllStreamingRepliesToInterrupted(statements, updatedAt)
    })
  }

  /**
   * Implements {@link ConversationTurnRecordWriter.updateAssistantMessageState},
   * interrupting the reply's open tool calls once the reply is finalized.
   * @param input - Interface-defined reply, terminal state, and message
   * timestamp.
   * @returns The interface-defined finalization outcome.
   * @throws The interface-defined closed and write failures.
   */
  public updateAssistantMessageState(
    input: UpdateAssistantMessageStateInput
  ): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      updateStreamingReplyState(statements, input)
    )
  }

  /**
   * Implements {@link ConversationTurnRecordWriter.updateUntitledConversationTitle}.
   * @param conversationId - Interface-defined conversation.
   * @param title - Interface-defined title.
   * @returns The interface-defined storage outcome.
   * @throws The interface-defined closed and write failures.
   */
  public updateUntitledConversationTitle(
    conversationId: string,
    title: string
  ): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .getStatement(
            "UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL"
          )
          .run(title, conversationId).changes === 1
    )
  }
}
