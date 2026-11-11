import * as z from "zod"
import {
  conversationAssistantMessageSchema,
  conversationMetadataSchema
} from "@lys/share"
import type {
  EndedReplyRecord,
  JobActivityReader,
  ReplyAddress
} from "../../../modules/delegation/records"
import type {
  DatabaseReader,
  DatabaseStatementCompiler
} from "../databaseTransactions"

/** Validates the stored address of one streaming reply. */
const replyAddressSchema = z.strictObject({
  /** Identity of the conversation that holds the reply. */
  conversationId: conversationMetadataSchema.shape.id,
  /** Identity of the reply. */
  assistantMessageId: conversationAssistantMessageSchema.shape.id
})

/** Validates one stored reply as the end of its generation is reported. */
const endedReplyRecordSchema = z.strictObject({
  /** Identity of the conversation that holds the reply. */
  conversationId: conversationMetadataSchema.shape.id,
  /** Identity of that conversation's parent; null for a main conversation. */
  parentConversationId: conversationMetadataSchema.shape.parentConversationId,
  /** Stored state of the reply. */
  status: conversationAssistantMessageSchema.shape.status,
  /** Stored finish reason; null unless the reply completed. */
  finishReason: conversationAssistantMessageSchema.shape.finishReason,
  /** Text of the reply's last round, possibly empty. */
  lastRoundText: z.string()
})

/**
 * Answers whether a `result` or `failed` report of one of a conversation's
 * jobs is not delivered, inside the caller's read transaction.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param parentConversationId - Stored UUIDv7 of the conversation.
 * @returns True when such a report is stored.
 * @throws If SQLite access fails.
 */
function hasUndeliveredWakingReport(
  statements: DatabaseStatementCompiler,
  parentConversationId: string
): boolean {
  const row = statements
    .getStatement(
      `SELECT EXISTS (SELECT 1 FROM conversations j
      JOIN job_reports r ON r.job_conversation_id = j.id
      WHERE j.parent_conversation_id = ? AND r.kind IN ('result', 'failed')
        AND r.delivered_message_id IS NULL) AS isFound`
    )
    .get(parentConversationId)
  return row?.isFound === 1
}

/**
 * Answers whether a reply of one conversation is streaming, inside the
 * caller's read transaction.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param conversationId - Stored UUIDv7 of the conversation.
 * @returns True when one of its own replies is streaming.
 * @throws If SQLite access fails.
 */
function hasStreamingReply(
  statements: DatabaseStatementCompiler,
  conversationId: string
): boolean {
  const row = statements
    .getStatement(
      `SELECT EXISTS (SELECT 1 FROM conversation_messages
      WHERE conversation_id = ? AND role = 'assistant'
        AND status = 'streaming') AS isFound`
    )
    .get(conversationId)
  return row?.isFound === 1
}

/**
 * Reads the streaming replies of one conversation and of every job below it,
 * inside the caller's read transaction.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param conversationId - Stored UUIDv7 of the conversation.
 * @returns The validated addresses: the conversation's own reply first, then
 * those of the jobs below it by the jobs' creation time and identity, and the
 * replies of one conversation by their own creation time and identity.
 * @throws If SQLite access or persisted validation fails.
 * @remarks `UNION` drops a conversation the walk already reached, so the
 * walk ends whatever parents are stored. `CROSS JOIN` keeps the two tables
 * in the written order, so each conversation's replies are found through the
 * message index and no call scans every message.
 */
function listStreamingReplies(
  statements: DatabaseStatementCompiler,
  conversationId: string
): ReplyAddress[] {
  return statements
    .getStatement(
      `WITH RECURSIVE below (id, created_at) AS (
      SELECT c.id, c.created_at FROM conversations c
        WHERE c.id = $conversationId
      UNION
      SELECT j.id, j.created_at FROM conversations j
        JOIN below b ON j.parent_conversation_id = b.id)
    SELECT r.conversation_id AS conversationId, r.id AS assistantMessageId
    FROM below b
    CROSS JOIN conversation_messages r ON r.conversation_id = b.id
    WHERE r.role = 'assistant' AND r.status = 'streaming'
    ORDER BY b.id <> $conversationId, b.created_at, b.id, r.created_at, r.id`
    )
    .all({ conversationId })
    .map((row) => replyAddressSchema.parse(row))
}

/**
 * Reads one stored reply as the end of its generation is reported, inside
 * the caller's read transaction.
 *
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param assistantMessageId - Stored UUIDv7 of the reply.
 * @returns The validated record, or undefined when no assistant message has
 * the identity. The text is that of the text parts of the highest round any
 * part of the reply belongs to, joined in position order.
 * @throws If SQLite access or persisted validation fails.
 */
function findEndedReply(
  statements: DatabaseStatementCompiler,
  assistantMessageId: string
): EndedReplyRecord | undefined {
  const row = statements
    .getStatement(
      `SELECT r.conversation_id AS conversationId,
      c.parent_conversation_id AS parentConversationId, r.status,
      r.finish_reason AS finishReason,
      coalesce(
        (SELECT group_concat(p.content, '' ORDER BY p.position)
          FROM conversation_messages p
          WHERE p.reply_id = r.id AND p.role = 'text'
            AND p.round = (SELECT max(q.round) FROM conversation_messages q
              WHERE q.reply_id = r.id)),
        '') AS lastRoundText
    FROM conversation_messages r JOIN conversations c ON c.id = r.conversation_id
    WHERE r.id = ? AND r.role = 'assistant'`
    )
    .get(assistantMessageId)
  if (row === undefined) return undefined
  return endedReplyRecordSchema.parse(row)
}

/**
 * Borrows the shared database's read snapshots to read what the replies and
 * the reports of conversations and their jobs wait for.
 *
 * @remarks Invariant: each call is one read snapshot that changes nothing,
 * and returned records are independent copies. Owns no resource: the
 * database's owner closes the connection, after which every operation fails
 * with `Database is closed`. Concurrency model: single-owner, synchronous on
 * the backend's event loop. Implements {@link JobActivityReader}.
 */
export default class SqliteJobActivityReader implements JobActivityReader {
  /** Borrowed read snapshots for every reply and report query. */
  readonly #databaseReader: DatabaseReader

  /**
   * Retains borrowed read access without performing database work.
   * @param databaseReader - Read snapshots lent by the database owner.
   */
  public constructor(databaseReader: DatabaseReader) {
    this.#databaseReader = databaseReader
  }

  /**
   * Implements {@link JobActivityReader.hasUndeliveredWakingReport} in one
   * read snapshot.
   * @param parentConversationId - Interface-defined identity.
   * @returns The interface-defined answer.
   * @throws The interface-defined closed failure.
   */
  public hasUndeliveredWakingReport(parentConversationId: string): boolean {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      hasUndeliveredWakingReport(statements, parentConversationId)
    )
  }

  /**
   * Implements {@link JobActivityReader.hasStreamingReply} in one read
   * snapshot.
   * @param conversationId - Interface-defined identity.
   * @returns The interface-defined answer.
   * @throws The interface-defined closed failure.
   */
  public hasStreamingReply(conversationId: string): boolean {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      hasStreamingReply(statements, conversationId)
    )
  }

  /**
   * Implements {@link JobActivityReader.listStreamingReplies} in one read
   * snapshot.
   * @param conversationId - Interface-defined identity.
   * @returns The interface-defined replies.
   * @throws The interface-defined closed and validation failures.
   */
  public listStreamingReplies(conversationId: string): readonly ReplyAddress[] {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      listStreamingReplies(statements, conversationId)
    )
  }

  /**
   * Implements {@link JobActivityReader.findEndedReply} in one read snapshot.
   * @param assistantMessageId - Interface-defined identity.
   * @returns The interface-defined record or absence.
   * @throws The interface-defined closed and validation failures.
   */
  public findEndedReply(
    assistantMessageId: string
  ): EndedReplyRecord | undefined {
    return this.#databaseReader.handleDatabaseReadRequest((statements) =>
      findEndedReply(statements, assistantMessageId)
    )
  }
}
