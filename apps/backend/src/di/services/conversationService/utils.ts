import * as z from "zod"
import type { ConversationMetadata } from "@lys/share"
import {
  DEFAULT_CONVERSAION_LIST_LIMIT,
  MAXIMUM_CONVERSATION_LIST_LIMIT,
  type ListConversationMetadataOptions,
  type VerifiedListConversationMetadataOptions
} from "./share"

/** Validates the versioned, opaque keyset cursor used by conversation lists. */
const conversationListCursorSchema = z.strictObject({
  /** Cursor format version used to reject incompatible encodings. */
  version: z.int(),
  /** Normalized query text to which the cursor is bound. */
  query: z.string(),
  /** Reserved score field retained in the cursor representation. */
  score: z.number().nullable(),
  /** Updated-time boundary of the final row in the previous page. */
  updatedAt: z.string(),
  /** UUIDv7 boundary ID used to disambiguate equal timestamps. */
  id: z.uuidv7()
})

/** Version supported by the current conversation-list cursor contract. */
const currentConversationListCursorVersion = 1

/** Validated cursor boundary used to resume one normalized conversation query. */
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
 * @returns The decoded current-version cursor, or `undefined` when omitted or supplied as an empty string.
 * @throws If a non-empty cursor is whitespace-only, malformed, or uses an unsupported version.
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
 * @param query - Normalized cursor-bound query value.
 * @param conversation - Final conversation included in the current page.
 * @returns An opaque Base64-encoded cursor for the following page.
 * @throws If the conversation identity or timestamp cannot satisfy the cursor schema.
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

/**
 * Trims the optional query value carried by a conversation metadata cursor.
 *
 * @param query - Optional raw query text supplied by a list caller.
 * @returns The trimmed query, or an empty string when no query is supplied; the current metadata SQL remains unfiltered.
 */
export function normalizeListConversationMetadataQuery(query?: string): string {
  if (!query) return ""
  return query.trim()
}

/**
 * Applies the inclusive bounds for a conversation metadata page size.
 *
 * @param limit - Optional requested page size; omission selects the default.
 * @returns An integer page size between the inclusive minimum of one and the configured maximum.
 * @throws If `limit` is not a safe integer in the supported inclusive range.
 */
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
 * Normalizes and validates conversation metadata list options for one request.
 *
 * @param options - Untrusted optional query, cursor, and limit list inputs.
 * @returns Validated options with a normalized cursor-bound query and decoded cursor.
 * @throws If the limit or cursor is invalid or unsupported, or the cursor's bound query value differs from the normalized request value.
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
