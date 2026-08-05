import type { PathLike } from "node:fs"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import {
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationUserMessageSchema,
  type ConversationAssistantMessage,
  type ConversationAssistantMessageFinishReason,
  type ConversationAssistantMessageStatus,
  type ConversationMetadata,
  type ConversationUserMessage
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import { lysSystemPrompt } from "../../utils/prompts"

export type ConversationServiceCreationOptions = {
  databaseFilePath: PathLike
}

export type ConversationCreationOptions = {
  systemPrompt?: string
}

export type GetConversationMetadataOptions = {
  id: string
}

export type AddUserMessageToConversationOptions = {
  conversationId: string
  userMessageContent: string
}

export type AddAssistantMessageToConversationOptions = {
  conversationId: string
  assistantMessageContent: string
  model: string
  status: ConversationAssistantMessageStatus
  finishReason?: ConversationAssistantMessageFinishReason
}

export type UpdateAssistantMessageStateOptions = {
  assistantMessageId: string
  status?: ConversationAssistantMessageStatus | undefined
  finishReason?: ConversationAssistantMessageFinishReason | null | undefined
}

export type UpdateConversationTitleOptions = {
  conversationId: string
  conversationTitle: string
}

export type ListConversationMetadataOptions = {
  query?: string
  cursor?: string
  limit?: number
}

export type ListConversationMetadataResult = {
  conversations: ConversationMetadata[]
  total: number
  nextCursor: string | null
  hasNextPage: boolean
}

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

const currentDatabaseVersion = databaseMigrations.length

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

export default class ConversationService {
  #database: DatabaseSync
  #insertConversationStatement: StatementSync
  #getConversationMetadataStatement: StatementSync
  #insertUserMessageStatement: StatementSync
  #insertAssistantMessageStatement: StatementSync
  #updateAssistantMessageStateStatement: StatementSync
  #updateConversationTitleStatement: StatementSync

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
   * @param option - Optional system prompt override for the new conversation.
   * @returns The newly persisted conversation metadata.
   * @throws If metadata validation or SQLite persistence fails.
   */
  public createConversation(
    option?: ConversationCreationOptions
  ): ConversationMetadata {
    const { systemPrompt = lysSystemPrompt() } = option ?? {}
    const now = new Date().toISOString()

    const conversation = conversationMetadataSchema.parse({
      id: uuidv7(),
      title: null,
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
   * The database trigger automatically updates the conversation's updatedAt.
   *
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
   * Lists conversation metadata using fuzzy title search and keyset pagination.
   *
   * @param options - Optional query, opaque cursor, and result limit.
   * @returns Matching metadata, the total match count, and pagination state.
   * @throws If the limit or cursor is invalid, or SQLite access fails.
   */
  public listConversationMetadata(
    options: ListConversationMetadataOptions = {}
  ): ListConversationMetadataResult {
    
  }

  public [Symbol.dispose](): void {
    this.#database.close()
  }
}
