import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationMetadata,
  ConversationUserMessage
} from "@lys/share"
import type {
  ConversationTurnOperation,
  ConversationTurnRecordWriter,
  ConversationTurnTransaction
} from "../../../di/services/conversationService/records"
import type { AssistantMessageCompletion } from "../../../modules/chat/chat/persistence"
import type {
  DatabaseStatementCompiler,
  DatabaseWriter
} from "../databaseTransactions"
import { findConversation } from "./findConversation"

/** Appends one delta to an assistant reply only while it is still streaming. */
const UPDATE_ASSISTANT_MESSAGE_CONTENT_SQL = `UPDATE conversation_messages SET content = content || ?, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status = 'streaming'`

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
      .getStatement(
        `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
    WHERE conversation_id = ? AND role = 'assistant' AND status = 'streaming'`
      )
      .run(updatedAt, conversationId)
  }

  /**
   * Implements {@link ConversationTurnTransaction.createConversation}.
   * @param metadata - Interface-defined metadata.
   * @throws The interface-defined ended-transaction and duplicate failures.
   */
  public createConversation(metadata: ConversationMetadata): void {
    this.#statements
      .getStatement(
        `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        metadata.id,
        metadata.title,
        metadata.systemPrompt,
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
   * Implements {@link ConversationTurnTransaction.createUserMessage}.
   * @param conversationId - Interface-defined conversation.
   * @param message - Interface-defined message.
   * @throws The interface-defined failures; an absent conversation fails the
   * foreign-key constraint.
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
  }

  /**
   * Implements {@link ConversationTurnTransaction.createAssistantMessage}.
   * @param conversationId - Interface-defined conversation.
   * @param message - Interface-defined message.
   * @throws The interface-defined failures; an absent conversation fails the
   * foreign-key constraint.
   */
  public createAssistantMessage(
    conversationId: string,
    message: ConversationAssistantMessage
  ): void {
    this.#statements
      .getStatement(
        `INSERT INTO conversation_messages
    (id, conversation_id, role, model, content, status, finish_reason, created_at, updated_at)
    VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        conversationId,
        message.model,
        message.content,
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
   * @throws The interface-defined operation, asynchronous-operation, closed,
   * and commit failures.
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
    this.#databaseWriter.handleDatabaseWriteRequest((statements) =>
      statements
        .getStatement(
          `UPDATE conversation_messages SET status = 'interrupted', updated_at = ?
      WHERE role = 'assistant' AND status = 'streaming'`
        )
        .run(updatedAt)
    )
  }

  /**
   * Implements {@link ConversationTurnRecordWriter.updateAssistantMessageContent}.
   * @param assistantMessageId - Interface-defined reply.
   * @param content - Interface-defined delta.
   * @param updatedAt - Interface-defined message timestamp.
   * @returns The interface-defined append outcome.
   * @throws The interface-defined closed and write failures.
   */
  public updateAssistantMessageContent(
    assistantMessageId: string,
    content: string,
    updatedAt: string
  ): boolean {
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .getStatement(UPDATE_ASSISTANT_MESSAGE_CONTENT_SQL)
          .run(content, updatedAt, assistantMessageId).changes === 1
    )
  }

  /**
   * Implements {@link ConversationTurnRecordWriter.updateAssistantMessageState}.
   * @param assistantMessageId - Interface-defined reply.
   * @param completion - Interface-defined terminal state.
   * @param updatedAt - Interface-defined message timestamp.
   * @returns The interface-defined finalization outcome.
   * @throws The interface-defined closed and write failures.
   */
  public updateAssistantMessageState(
    assistantMessageId: string,
    completion: AssistantMessageCompletion,
    updatedAt: string
  ): boolean {
    const finishReason =
      completion.status === "completed" ? completion.finishReason : null
    return this.#databaseWriter.handleDatabaseWriteRequest(
      (statements) =>
        statements
          .getStatement(
            `UPDATE conversation_messages SET status = ?, finish_reason = ?, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status = 'streaming'`
          )
          .run(completion.status, finishReason, updatedAt, assistantMessageId)
          .changes === 1
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
