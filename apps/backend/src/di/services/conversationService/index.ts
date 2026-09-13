import { DatabaseSync, type StatementSync } from "node:sqlite"
import * as z from "zod"
import {
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationUserMessageSchema,
  type ConversationAssistantMessage,
  type ConversationMetadata,
  type ConversationUserMessage
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type {
  AddAssistantMessageToConversationOptions,
  AddUserMessageToConversationOptions,
  ConversationCreationOptions,
  ConversationServiceCreationOptions,
  GetConversationMetadataOptions,
  ListConversationMetadataOptions,
  ListConversationMetadataResult,
  UpdateAssistantMessageStateOptions,
  UpdateConversationTitleOptions
} from "./share"
import { lysSystemPrompt } from "../../../utils/prompts"
import {
  encodeConversationListCursor,
  verifyListConversationMetadataOptions
} from "./utils"

/**
 * Ordered SQLite schema migrations for the conversation store.
 *
 * @remarks Each entry advances `PRAGMA user_version` by one and is applied
 * inside the transaction opened by {@link migrateDatabase}. Later migrations
 * depend on the schema established by earlier entries.
 */
const databaseMigrations = [
  `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `,
  `
    CREATE TABLE conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      model TEXT,
      content TEXT NOT NULL,
      status TEXT CHECK (
        status IN ('streaming', 'completed', 'interrupted', 'failed')
      ),
      finish_reason TEXT CHECK (
        finish_reason IN ('stop', 'length')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT,
      CHECK (
        (
          role = 'user'
          AND model IS NULL
          AND length(content) > 0
          AND status IS NULL
          AND finish_reason IS NULL
          AND updated_at IS NULL
        )
        OR
        (
          role = 'assistant'
          AND status IS NOT NULL
          AND updated_at IS NOT NULL
          AND model IS NOT NULL
          AND length(model) > 0
          AND (
            (
              status = 'completed'
              AND finish_reason IS NOT NULL
            )
            OR
            (
              status IN ('streaming', 'interrupted', 'failed')
              AND finish_reason IS NULL
            )
          )
        )
      )
    ) STRICT;

    CREATE INDEX conversation_messages_conversation_idx
      ON conversation_messages (conversation_id, created_at, id);

    CREATE TRIGGER update_conversation_after_message_insert
    AFTER INSERT ON conversation_messages
    FOR EACH ROW
    BEGIN
      UPDATE conversations
      SET updated_at = NEW.created_at
      WHERE id = NEW.conversation_id;
    END;
  `,
  `
    CREATE TRIGGER update_conversation_updated_at
    AFTER UPDATE ON conversations
    FOR EACH ROW
    WHEN NEW.updated_at <= OLD.updated_at
    BEGIN
      UPDATE conversations
      SET updated_at = CASE
        WHEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') > OLD.updated_at
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ELSE strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          OLD.updated_at,
          '+0.001 seconds'
        )
      END
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER update_conversation_after_message_update
    AFTER UPDATE ON conversation_messages
    FOR EACH ROW
    BEGIN
      UPDATE conversations
      SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = NEW.conversation_id;
    END;
  `
] as const

/** Latest schema version that this service can open and migrate. */
const currentDatabaseVersion = databaseMigrations.length

/** Validates the total returned by the conversation metadata count query. */
const conversationMetadataCountSchema = z.strictObject({
  /** Number of stored conversations represented by the count aggregate. */
  total: z.number().int().nonnegative()
})

/**
 * Reads and validates the SQLite schema version marker.
 *
 * @param database - Open SQLite database whose `user_version` is inspected.
 * @returns The non-negative safe-integer schema version.
 * @throws If SQLite returns a missing, non-integer, unsafe, or negative version.
 */
function readDatabaseVersion(database: DatabaseSync): number {
  const databaseVersion = database
    .prepare("PRAGMA user_version")
    .get()?.user_version

  if (
    typeof databaseVersion !== "number" ||
    !Number.isSafeInteger(databaseVersion) ||
    databaseVersion < 0
  ) {
    throw new Error("Invalid database user_version")
  }

  return databaseVersion
}

/**
 * Applies all pending schema migrations atomically in version order.
 *
 * @param database - Open SQLite database whose schema is migrated in place.
 * @throws If the stored version is unsupported or any migration fails; an active transaction is rolled back before the failure propagates.
 */
function migrateDatabase(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE")

  try {
    const databaseVersion = readDatabaseVersion(database)

    if (databaseVersion > currentDatabaseVersion) {
      throw new Error(
        `Database version ${databaseVersion} is newer than supported version ${currentDatabaseVersion}`
      )
    }

    for (const [migrationIndex, migration] of databaseMigrations.entries()) {
      const migrationVersion = migrationIndex + 1

      if (migrationVersion <= databaseVersion) {
        continue
      }

      database.exec(migration)
      database.exec(`PRAGMA user_version = ${migrationVersion}`)
    }

    database.exec("COMMIT")
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK")
    }

    throw error
  }
}

/**
 * Owns one synchronous SQLite connection and prepared statements for persisted
 * conversation metadata and messages.
 *
 * @remarks The instance
 * owns its database connection and statements until synchronous disposal; the
 * database path is borrowed only during construction. Concurrency model:
 * single-owner and synchronous—each operation completes before the next
 * event-loop callback can use the service. Inserts and updates rely on SQLite
 * constraints and triggers to preserve message and conversation invariants.
 */
export default class ConversationService {
  /** Owned SQLite connection used by all persistence operations. */
  #database: DatabaseSync
  /** Prepared statement that inserts conversation metadata and its timestamps. */
  #insertConversationStatement: StatementSync
  /** Prepared statement that retrieves one conversation metadata record by ID. */
  #getConversationMetadataStatement: StatementSync
  /** Counts every stored conversation without search filtering. */
  #countConversationMetadataStatement: StatementSync
  /** Lists conversations by the unfiltered updated-time and ID keyset. */
  #listUnfilteredConversationMetadataStatement: StatementSync
  /** Prepared statement that appends one validated user message. */
  #insertUserMessageStatement: StatementSync
  /** Prepared statement that appends one validated assistant message. */
  #insertAssistantMessageStatement: StatementSync
  /** Prepared statement that conditionally updates assistant status and finish reason. */
  #updateAssistantMessageStateStatement: StatementSync
  /** Prepared statement that replaces a conversation title by ID. */
  #updateConversationTitleStatement: StatementSync

  /**
   * Opens a ready conversation store and prepares its schema statements.
   *
   * @param options - Filesystem path of the SQLite database to own.
   * @throws If SQLite cannot open the database, migrations fail, or a prepared statement cannot be created; an opened connection is closed before the failure propagates.
   */
  constructor({ databaseFilePath }: ConversationServiceCreationOptions) {
    const database = new DatabaseSync(databaseFilePath)

    try {
      migrateDatabase(database)

      this.#insertConversationStatement = database.prepare(`
        INSERT INTO conversations (
          id,
          title,
          system_prompt,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `)

      this.#getConversationMetadataStatement = database.prepare(`
        SELECT
          id,
          title,
          system_prompt AS systemPrompt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM conversations
        WHERE id = ?
      `)

      this.#countConversationMetadataStatement = database.prepare(`
        SELECT count(*) AS total FROM conversations
      `)

      this.#listUnfilteredConversationMetadataStatement = database.prepare(`
        SELECT
          id,
          title,
          system_prompt AS systemPrompt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM conversations
        WHERE ? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?)
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)

      this.#insertUserMessageStatement = database.prepare(`
        INSERT INTO conversation_messages (
          id,
          conversation_id,
          role,
          content,
          created_at
        ) VALUES (?, ?, 'user', ?, ?)
      `)

      this.#insertAssistantMessageStatement = database.prepare(`
        INSERT INTO conversation_messages (
          id,
          conversation_id,
          role,
          model,
          content,
          status,
          finish_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)
      `)

      this.#updateAssistantMessageStateStatement = database.prepare(`
        UPDATE conversation_messages
        SET
          status = CASE
            WHEN ? = 1 THEN ?
            ELSE status
          END,
          finish_reason = CASE
            WHEN ? = 1 THEN ?
            ELSE finish_reason
          END,
          updated_at = ?
        WHERE id = ?
          AND role = 'assistant' 
      `)

      this.#updateConversationTitleStatement = database.prepare(`
        UPDATE conversations
        SET title = ?
        WHERE id = ?
      `)
    } catch (error) {
      database.close()
      throw error
    }

    this.#database = database
  }

  /**
   * Creates and persists metadata for one empty conversation.
   *
   * @remarks Every new conversation is stored with the default title
   * `New Conversation`. Title generation may later replace it; when generation
   * fails, the conversation keeps the default. Changing the default affects
   * only conversations created afterwards.
   * @param option - Optional system prompt override for the new conversation.
   * @returns The newly persisted conversation metadata.
   * @throws If metadata validation or SQLite persistence fails.
   */
  public createConversation(
    option?: ConversationCreationOptions
  ): ConversationMetadata {
    /** Title stored with every new conversation until title generation replaces it. */
    const defaultConversationTitle = "New Conversation"
    const { systemPrompt = lysSystemPrompt() } = option ?? {}
    const now = new Date().toISOString()

    const conversation = conversationMetadataSchema.parse({
      id: uuidv7(),
      title: defaultConversationTitle,
      systemPrompt,
      createdAt: now,
      updatedAt: now
    })

    this.#insertConversationStatement.run(
      conversation.id,
      conversation.title,
      conversation.systemPrompt,
      conversation.createdAt,
      conversation.updatedAt
    )

    return conversation
  }

  /**
   * Retrieves metadata for one conversation without loading its messages.
   *
   * @param options - UUIDv7 identifying the conversation to read.
   * @returns The validated metadata, or `undefined` when no row has that ID.
   * @throws If the returned row violates the metadata schema or SQLite access fails.
   */
  public getConversationMetadata({
    id
  }: GetConversationMetadataOptions): ConversationMetadata | undefined {
    const row = this.#getConversationMetadataStatement.get(id)
    if (row === undefined) {
      return undefined
    }

    return conversationMetadataSchema.parse(row)
  }

  /**
   * Creates and persists a user message in an existing conversation.
   *
   * The synchronous SQLite INSERT trigger automatically updates the parent
   * conversation's updatedAt to the new user message's createdAt before the
   * method returns.
   *
   * @param options - Conversation ID and non-empty authored message content.
   * @returns The validated user message written to SQLite.
   * @throws If validation fails, the conversation does not exist, or SQLite
   * persistence fails.
   */
  public addUserMessageToConversation({
    conversationId,
    userMessageContent
  }: AddUserMessageToConversationOptions): ConversationUserMessage {
    const userMessage = conversationUserMessageSchema.parse({
      id: uuidv7(),
      role: "user",
      content: userMessageContent,
      createdAt: new Date().toISOString()
    })

    this.#insertUserMessageStatement.run(
      userMessage.id,
      conversationId,
      userMessage.content,
      userMessage.createdAt
    )

    return userMessage
  }

  /**
   * Creates and persists an assistant message with its initial lifecycle state.
   *
   * The synchronous SQLite INSERT trigger updates the parent conversation's
   * updatedAt to the assistant message's createdAt before this method returns.
   *
   * @param options - Conversation, content, model, status, and optional finish reason for the message.
   * @returns The validated assistant message written to SQLite.
   * @throws If validation fails, the conversation does not exist, or SQLite persistence fails.
   */
  public addAssistantMessageToConversation({
    conversationId,
    assistantMessageContent,
    model,
    status,
    finishReason
  }: AddAssistantMessageToConversationOptions): ConversationAssistantMessage {
    const now = new Date().toISOString()
    const assistantMessage = conversationAssistantMessageSchema.parse({
      id: uuidv7(),
      role: "assistant",
      model,
      content: assistantMessageContent,
      status,
      finishReason: finishReason ?? null,
      createdAt: now,
      updatedAt: now
    })

    this.#insertAssistantMessageStatement.run(
      assistantMessage.id,
      conversationId,
      assistantMessage.model,
      assistantMessage.content,
      assistantMessage.status,
      assistantMessage.finishReason,
      assistantMessage.createdAt,
      assistantMessage.updatedAt
    )

    return assistantMessage
  }

  /**
   * Updates selected lifecycle fields of one assistant message atomically.
   *
   * When a field is changed, the synchronous SQLite UPDATE trigger advances the
   * parent conversation's updatedAt before this method returns.
   *
   * @param options - Message ID and optional status or finish-reason changes; omitted fields remain unchanged and `null` clears a finish reason.
   * @throws If no assistant row matches the ID or SQLite persistence fails.
   */
  public updateAssistantMessageState({
    assistantMessageId,
    status,
    finishReason
  }: UpdateAssistantMessageStateOptions) {
    const shouldUpdateStatus = status !== undefined
    const shouldUpdateFinishReason = finishReason !== undefined

    if (!shouldUpdateStatus && !shouldUpdateFinishReason) {
      return
    }

    const result = this.#updateAssistantMessageStateStatement.run(
      shouldUpdateStatus ? 1 : 0,
      status ?? null,
      shouldUpdateFinishReason ? 1 : 0,
      finishReason ?? null,
      new Date().toISOString(),
      assistantMessageId
    )

    if (Number(result.changes) !== 1) {
      throw new Error(`Assistant message "${assistantMessageId}" was not found`)
    }
  }

  /**
   * Replaces a conversation title after trimming and rejecting empty content.
   *
   * The synchronous SQLite UPDATE trigger may advance the conversation's
   * updatedAt before this method returns.
   *
   * @param options - Conversation ID and candidate title supplied by the caller.
   * @throws If the normalized title is empty, no conversation matches the ID, or SQLite persistence fails.
   */
  public updateConversationTitle({
    conversationId,
    conversationTitle
  }: UpdateConversationTitleOptions) {
    const title = conversationTitle.trim()

    if (title.length === 0) {
      throw new Error("Conversation title must not be empty")
    }

    const result = this.#updateConversationTitleStatement.run(
      title,
      conversationId
    )

    if (Number(result.changes) !== 1) {
      throw new Error(`Conversation "${conversationId}" was not found`)
    }
  }

  /**
   * Lists conversation metadata using unfiltered keyset pagination; the
   * normalized query is retained only as a cursor binding.
   *
   * @param options - Optional cursor-bound query value, opaque cursor, and result limit.
   * @returns Metadata rows in descending updated-time/ID order, the total stored-row count, and pagination state.
   * @throws If the limit or cursor is invalid, count or row data fail repository-schema validation, or SQLite access fails.
   */
  public listConversationMetadata(
    options: ListConversationMetadataOptions = {}
  ): ListConversationMetadataResult {
    const { cursor, limit, query } =
      verifyListConversationMetadataOptions(options)
    const total = conversationMetadataCountSchema.parse(
      this.#countConversationMetadataStatement.get()
    ).total
    const rows = this.#listUnfilteredConversationMetadataStatement.all(
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1
    )
    const hasNextPage = rows.length > limit
    const conversations = conversationMetadataSchema
      .array()
      .parse(rows.slice(0, limit))
    const lastConversation = conversations.at(-1)
    const nextCursor =
      hasNextPage && lastConversation !== undefined
        ? encodeConversationListCursor(query, lastConversation)
        : null

    return { conversations, total, nextCursor, hasNextPage }
  }

  /**
   * Closes the owned SQLite connection and all prepared statements.
   *
   * @remarks Disposal is synchronous and must occur after the application stops using this service.
   */
  public [Symbol.dispose](): void {
    this.#database.close()
  }
}
