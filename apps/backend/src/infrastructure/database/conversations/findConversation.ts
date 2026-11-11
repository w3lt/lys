import type { DatabaseStatementCompiler } from "../databaseTransactions"
import {
  listDeliveredJobReports,
  type DeliveredJobReports
} from "../delegation/jobReports"
import { listConversationJobs } from "../delegation/jobs"
import {
  conversationMetadataSchema,
  conversationMessageSchema,
  conversationSourceSchema,
  isAnsweredToolCallStatus,
  replyPartSchema,
  toolCallReplyPartStatusSchema,
  type Conversation,
  type ConversationMetadata,
  type ConversationMessage,
  type ConversationSource,
  type ReplyPart
} from "@lys/share"

/** One stored row as SQLite returns it, before validation. */
type StoredRow = Record<string, unknown>

/** Parts of each reply of one conversation, by reply identity. */
type StoredReplyParts = ReadonlyMap<unknown, readonly ReplyPart[]>

/**
 * Untrusted attachments of each user message of one conversation, by message
 * identity, each in the shape the attachment schema validates.
 */
type StoredMessageAttachments = ReadonlyMap<unknown, readonly unknown[]>

/** What the loaded messages of one conversation are built from. */
type StoredMessageContext = Readonly<{
  /** Validated parts of the conversation's replies. */
  partsByReply: StoredReplyParts
  /** Untrusted attachments of the conversation's user messages. */
  attachmentsByMessage: StoredMessageAttachments
  /** Validated reports the conversation's user messages delivered. */
  reportsByMessage: DeliveredJobReports
}>

/**
 * Projects one stored attachment row into the shape the attachment schema
 * validates: an image with its media type and sides, or a text file.
 * @param row - Untrusted stored attachment row.
 * @returns The untrusted projection.
 */
function buildStoredAttachment(row: StoredRow): unknown {
  const common = {
    kind: row.kind,
    number: row.number,
    name: row.name,
    sizeBytes: row.sizeBytes
  }
  if (row.kind !== "image") return common
  return {
    ...common,
    mediaType: row.mediaType,
    width: row.width,
    height: row.height
  }
}

/**
 * Reads the attachments of every user message of one conversation.
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param conversationId - Stored UUIDv7 of the conversation.
 * @returns Each message's untrusted attachments in number order, by message
 * id; a message without attachments has no entry.
 * @throws If SQLite access fails.
 */
function listStoredMessageAttachments(
  statements: DatabaseStatementCompiler,
  conversationId: string
): StoredMessageAttachments {
  const rows = statements
    .getStatement(
      `SELECT message_id AS messageId, number, name, kind,
    media_type AS mediaType, size_bytes AS sizeBytes, width, height
    FROM conversation_attachments WHERE conversation_id = ? ORDER BY number`
    )
    .all(conversationId)
  const attachmentsByMessage = new Map<unknown, unknown[]>()
  for (const row of rows) {
    const attachments = attachmentsByMessage.get(row.messageId) ?? []
    attachments.push(buildStoredAttachment(row))
    attachmentsByMessage.set(row.messageId, attachments)
  }
  return attachmentsByMessage
}

/**
 * Reads metadata without changing activity time.
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param conversationId - Stored UUIDv7 to look up.
 * @returns Independent metadata, or undefined for an absent conversation. A
 * job carries its parent, its number, and its parent's agent as the
 * delegator; a main conversation carries none of the three.
 * @throws If SQLite access or persisted validation fails.
 */
function findConversationMetadata(
  statements: DatabaseStatementCompiler,
  conversationId: string
): ConversationMetadata | undefined {
  const row = statements
    .getStatement(
      `SELECT c.id, c.title, c.agent_code AS agentCode,
    c.parent_conversation_id AS parentConversationId, c.job_number AS jobNumber,
    p.agent_code AS delegatorAgentCode,
    c.created_at AS createdAt, c.updated_at AS updatedAt
    FROM conversations c
    LEFT JOIN conversations p ON p.id = c.parent_conversation_id
    WHERE c.id = ?`
    )
    .get(conversationId)
  if (row === undefined) return undefined
  return conversationMetadataSchema.parse(row)
}

/**
 * Answers whether a stored call's status is one whose part carries the result
 * the model read.
 * @param status - Untrusted stored status.
 * @returns True for a status {@link isAnsweredToolCallStatus} answers true
 * for; false for any other status, and for a value that is no status, which
 * the part schema then refuses.
 */
function hasStoredToolCallResult(status: unknown): boolean {
  const parsedStatus = toolCallReplyPartStatusSchema.safeParse(status)
  return parsedStatus.success && isAnsweredToolCallStatus(parsedStatus.data)
}

/**
 * Projects the columns of one stored tool call into its part shape.
 * @param row - Untrusted stored tool-call row.
 * @returns The untrusted projection: the result only for a status that has
 * one, and for a succeeded call its stored source numbers decoded, or none
 * when absent.
 * @throws If stored source numbers are not JSON.
 */
function buildToolCallPart(row: StoredRow): unknown {
  const common = {
    kind: "tool-call",
    id: row.id,
    round: row.round,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    toolName: row.toolName,
    argumentText: row.toolArguments,
    status: row.status
  }
  const part = hasStoredToolCallResult(row.status)
    ? { ...common, result: row.content }
    : common
  if (row.status !== "succeeded") return part
  const sourceNumbers: unknown =
    typeof row.sourceNumbers === "string" ? JSON.parse(row.sourceNumbers) : []
  return { ...part, sourceNumbers }
}

/**
 * Projects one stored reply piece into the strict part contract.
 * @param row - Untrusted stored piece row with the columns `id`, `role`,
 * `round`, `content`, `status`, `toolName`, `toolArguments`,
 * `sourceNumbers`, `createdAt`, and `updatedAt`.
 * @returns The validated independent part.
 * @throws If the row violates the shared part schema, or its stored source
 * numbers are not JSON.
 */
export function parseStoredReplyPart(row: StoredRow): ReplyPart {
  if (row.role === "tool_call")
    return replyPartSchema.parse(buildToolCallPart(row))
  return replyPartSchema.parse({
    kind: row.role,
    id: row.id,
    round: row.round,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    content: row.content
  })
}

/**
 * Reads the parts of every reply of one conversation.
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param conversationId - Stored UUIDv7 of the conversation.
 * @returns Each reply's validated parts in position order, by reply id.
 * @throws If SQLite access or persisted validation fails.
 */
function listStoredReplyParts(
  statements: DatabaseStatementCompiler,
  conversationId: string
): StoredReplyParts {
  const rows = statements
    .getStatement(
      `SELECT id, role, reply_id AS replyId, round, content, status,
    tool_name AS toolName, tool_arguments AS toolArguments,
    source_numbers AS sourceNumbers, created_at AS createdAt, updated_at AS updatedAt
    FROM conversation_messages WHERE conversation_id = ? AND reply_id IS NOT NULL
    ORDER BY reply_id, position`
    )
    .all(conversationId)
  const partsByReply = new Map<unknown, ReplyPart[]>()
  for (const row of rows) {
    const replyParts = partsByReply.get(row.replyId) ?? []
    replyParts.push(parseStoredReplyPart(row))
    partsByReply.set(row.replyId, replyParts)
  }
  return partsByReply
}

/**
 * Projects role-specific SQLite columns into the strict message contract.
 * @param row - Untrusted stored user or reply row selected by findConversation.
 * @param context - Validated parts of the conversation's replies, and the
 * untrusted attachments and validated delivered reports of its user
 * messages.
 * @returns The validated independent message; a user message carries its
 * attachments, who wrote it, and the reports it delivered, and a reply its
 * parts. A user message stored without an origin is the person's.
 * @throws If the row, or an attachment of it, violates the shared message
 * schema.
 */
function parseConversationMessage(
  row: StoredRow,
  { partsByReply, attachmentsByMessage, reportsByMessage }: StoredMessageContext
): ConversationMessage {
  const common = {
    id: row.id,
    role: row.role,
    createdAt: row.createdAt
  }
  if (row.role === "user")
    return conversationMessageSchema.parse({
      ...common,
      content: row.content,
      attachments: attachmentsByMessage.get(row.id) ?? [],
      origin: row.origin ?? "person",
      reports: reportsByMessage.get(row.id) ?? []
    })
  return conversationMessageSchema.parse({
    ...common,
    model: row.model,
    parts: partsByReply.get(row.id) ?? [],
    status: row.status,
    finishReason: row.finishReason,
    updatedAt: row.updatedAt
  })
}

/**
 * Reads the sources one conversation's tool calls read.
 * @param statements - Statement compilation lent to the caller's transaction.
 * @param conversationId - Stored UUIDv7 of the conversation.
 * @returns The validated sources in number order.
 * @throws If SQLite access or persisted validation fails.
 */
function listConversationSources(
  statements: DatabaseStatementCompiler,
  conversationId: string
): ConversationSource[] {
  return statements
    .getStatement(
      `SELECT number, url, title FROM conversation_sources
    WHERE conversation_id = ? ORDER BY number`
    )
    .all(conversationId)
    .map((row) => conversationSourceSchema.parse(row))
}

/**
 * Reads a full transcript in creation-time and UUID order, with each user
 * message's attachments and delivered reports, each reply's parts, and the
 * conversation's sources and jobs.
 * @param statements - Statement compilation lent to the caller's read or write transaction.
 * @param conversationId - Stored UUIDv7 to look up.
 * @returns Independent conversation data of a main conversation or a job,
 * with the jobs started from it in number order, or undefined when absent.
 * Reading it never touches the attachment files.
 * @throws If SQLite access or persisted validation fails.
 */
export function findConversation(
  statements: DatabaseStatementCompiler,
  conversationId: string
): Conversation | undefined {
  const metadata = findConversationMetadata(statements, conversationId)
  if (!metadata) return undefined
  const context: StoredMessageContext = {
    partsByReply: listStoredReplyParts(statements, conversationId),
    attachmentsByMessage: listStoredMessageAttachments(
      statements,
      conversationId
    ),
    reportsByMessage: listDeliveredJobReports(statements, conversationId)
  }
  const rows = statements
    .getStatement(
      `SELECT id, role, model, content, status, origin,
    finish_reason AS finishReason, created_at AS createdAt, updated_at AS updatedAt
    FROM conversation_messages
    WHERE conversation_id = ? AND role IN ('user', 'assistant') ORDER BY created_at, id`
    )
    .all(conversationId)
  return {
    ...metadata,
    messages: rows.map((row) => parseConversationMessage(row, context)),
    sources: listConversationSources(statements, conversationId),
    jobs: listConversationJobs(statements, conversationId)
  }
}
