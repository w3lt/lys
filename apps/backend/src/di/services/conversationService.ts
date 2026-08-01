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

export default class ConversationService {
  #database: DatabaseSync
  #insertConversationStatement: StatementSync
  #getConversationMetadataStatement: StatementSync

  constructor({ databaseFilePath }: ConversationServiceCreationOptions) {
    const database = new DatabaseSync(databaseFilePath)

    try {
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
