import * as z from "zod"
import type { AgentSummary, ListAgentsApiQuery } from "@lys/protocol"
import { agentCodeSchema } from "@lys/share"

/** Version-one cursor naming the last agent of the previous page. */
const agentListCursorSchema = z.strictObject({
  version: z.literal(1),
  createdAt: z.iso.datetime({ precision: 3 }),
  code: agentCodeSchema
})

/** Validated continuation naming the last agent of the previous page. */
type AgentListCursor = z.infer<typeof agentListCursorSchema>

/**
 * Page size the list-option parser applies when a caller omits the bounded
 * API limit; a caller overrides it by passing `limit`.
 */
const DEFAULT_AGENT_LIST_LIMIT = 30

/** Trusted cursor and page size supplied to the agent lister. */
export type AgentListOptions = Readonly<{
  /** Validated boundary, absent for the first page. */
  cursor: AgentListCursor | undefined
  /** Inclusive page size bounded by the shared API schema. */
  limit: number
}>

/**
 * Creates a versioned opaque continuation after the last listed agent.
 * @param agent - Last row of a nonterminal page.
 * @returns Base64 of UTF-8 JSON, accepted by {@link parseAgentListOptions}.
 */
export function createAgentListCursor(agent: AgentSummary): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      createdAt: agent.createdAt,
      code: agent.code
    } satisfies AgentListCursor),
    "utf8"
  ).toString("base64")
}

/**
 * Decodes and validates a continuation cursor.
 * @param cursor - Cursor text from the list query.
 * @returns The boundary the cursor names.
 * @throws If the text is not canonical base64 of UTF-8 JSON, or the JSON is
 * not a version-one agent list cursor.
 */
function parseAgentListCursor(cursor: string): AgentListCursor {
  const decoded = Buffer.from(cursor, "base64")
  if (decoded.toString("base64") !== cursor)
    throw new Error("Agent list cursor is not canonical base64")
  return agentListCursorSchema.parse(JSON.parse(decoded.toString("utf8")))
}

/**
 * Invalid list cursor mapped by Fastify to a caller-safe HTTP 400.
 *
 * @remarks The subclass preserves the native `Error` contract, keeping the
 * cursor failure as its cause, and always reports status 400. It owns no
 * mutable state and is safe to construct once per failure.
 */
class AgentListInputError extends Error {
  /**
   * Preserves the decoding failure for server diagnostics.
   * @param cause - Original invalid cursor failure.
   */
  constructor(cause: unknown) {
    super("Invalid agent list cursor", { cause })
  }
  /** HTTP status consumed by Fastify's error boundary. @returns The invalid-input status. */
  get statusCode(): number {
    return 400
  }
}

/**
 * Translates a validated list query into lister options, decoding its cursor.
 * @param query - Query values already validated by the list endpoint schema.
 * @returns The boundary named by the cursor, absent without one, and the
 * requested page size or the default.
 * @throws AgentListInputError when the cursor is not canonical base64 of
 * UTF-8 JSON, or its JSON is not a version-one agent list cursor.
 */
export function parseAgentListOptions(
  query: ListAgentsApiQuery
): AgentListOptions {
  const limit = query.limit ?? DEFAULT_AGENT_LIST_LIMIT
  if (query.cursor === undefined) return { cursor: undefined, limit }
  try {
    return { cursor: parseAgentListCursor(query.cursor), limit }
  } catch (cause) {
    throw new AgentListInputError(cause)
  }
}
