import * as z from "zod"
import type { ConversationMetadata } from "@lys/share"
import {
  DEFAULT_CONVERSAION_LIST_LIMIT,
  MAXIMUM_CONVERSATION_LIST_LIMIT,
  type ListConversationMetadataOptions,
  type VerifiedListConversationMetadataOptions
} from "./share"

const conversationListCursorSchema = z.strictObject({
  version: z.int(),
  query: z.string(),
  score: z.number().nullable(),
  updatedAt: z.string(),
  id: z.uuidv7()
})

/** Version supported by the current conversation-list cursor contract. */
const currentConversationListCursorVersion = 1

export type ConversationListCursor = z.infer<
  typeof conversationListCursorSchema
>

/**
 * Parses an encoded conversation-list cursor into its validated representation.
 *
 * @param encodedCursor - Base64-encoded JSON cursor supplied by a list client.
 * @returns The structurally valid cursor represented by `encodedCursor`.
 * @throws If the encoded value cannot be decoded, parsed, or validated.
 */
function parseConversationListCursor(
  encodedCursor: string
): ConversationListCursor {
  try {
    return conversationListCursorSchema.parse(
      JSON.parse(Buffer.from(encodedCursor, "base64").toString("utf-8"))
    )
  } catch (error) {
    throw new Error("Invalid conversation list cursor", { cause: error })
  }
}

/**
 * Decodes an optional conversation-list cursor accepted by this service.
 *
 * @param encodedCursor - Optional Base64-encoded cursor from a list client.
 * @returns The decoded current-version cursor, or `undefined` when omitted.
 * @throws If the cursor is blank, malformed, or uses an unsupported version.
 */
export function decodeConversationListCursor(
  encodedCursor?: string
): ConversationListCursor | undefined {
  if (!encodedCursor) return undefined

  if (encodedCursor.trim().length === 0)
    throw new Error("Invalid cursor length")

  const cursor = parseConversationListCursor(encodedCursor)

  if (cursor.version !== currentConversationListCursorVersion) {
    throw new Error("Unsupported conversation list cursor version")
  }

  return cursor
}

/**
 * Encodes an opaque cursor that resumes a conversation metadata list query.
 *
 * @param query - Normalized list query bound to the returned cursor.
 * @param conversation - Final conversation included in the current page.
 * @returns An opaque Base64-encoded cursor for the following page.
 */
export function encodeConversationListCursor(
  query: string,
  conversation: Pick<ConversationMetadata, "id" | "updatedAt">
): string {
  const cursor = conversationListCursorSchema.parse({
    version: currentConversationListCursorVersion,
    query,
    score: null,
    updatedAt: conversation.updatedAt,
    id: conversation.id
  })

  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64")
}

export function normalizeListConversationMetadataQuery(query?: string): string {
  if (!query) return ""
  return query.trim()
}

export function validateConversationListLimit(limit?: number): number {
  const normalizedLimit = limit ?? DEFAULT_CONVERSAION_LIST_LIMIT

  if (
    !Number.isSafeInteger(normalizedLimit) ||
    normalizedLimit < 1 ||
    normalizedLimit > MAXIMUM_CONVERSATION_LIST_LIMIT
  ) {
    throw new RangeError(
      `Conversation list limit must be an integer between 1 and ${MAXIMUM_CONVERSATION_LIST_LIMIT}`
    )
  }

  return normalizedLimit
}

/**
 * Normalizes and validates conversation metadata list options for one query.
 *
 * @param options - Untrusted optional query, cursor, and limit list inputs.
 * @returns Validated options with a normalized query and decoded cursor.
 * @throws If the limit or cursor is invalid, unsupported, or for another query.
 */
export function verifyListConversationMetadataOptions(
  options: ListConversationMetadataOptions
): VerifiedListConversationMetadataOptions {
  const query = normalizeListConversationMetadataQuery(options.query)
  const cursor = decodeConversationListCursor(options.cursor)
  const limit = validateConversationListLimit(options.limit)

  if (cursor !== undefined && cursor.query !== query) {
    throw new Error("Conversation list cursor query does not match list query")
  }

  return {
    cursor,
    query,
    limit
  }
}
