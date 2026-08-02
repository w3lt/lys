import type { PathLike } from "node:fs"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import {
  conversationMetadataSchema,
  conversationSchema,
  type ConversationMetadata
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

const databaseMigrations = [
  `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
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
    } catch (error) {
      database.close()
      throw error
    }

    this.#database = database
  }

  public createConversation(
    option?: ConversationCreationOptions
  ): ConversationMetadata {
    const { systemPrompt = lysSystemPrompt() } = option ?? {}
    const now = new Date().toISOString()

    const conversation = conversationSchema.parse({
      id: uuidv7(),
      title: null,
      systemPrompt,
      messages: [],
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

  public [Symbol.dispose](): void {
    this.#database.close()
  }
}
