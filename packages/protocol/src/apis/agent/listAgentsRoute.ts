import * as z from "zod"
import { agentSchema } from "@lys/share"
import { apiAgentsRoute } from "./routes"

/**
 * Inclusive maximum number of agents one list page may contain.
 *
 * @remarks Transmitted as the upper bound of the `limit` query parameter and
 * enforced on the response collection. It is not persisted. Raising it is a
 * compatible change for clients; lowering it can reject existing requests.
 */
export const MAXIMUM_AGENT_LIST_PAGE_SIZE = 50

/** Inclusive maximum length of the opaque continuation cursor in either direction. */
const MAXIMUM_AGENT_LIST_CURSOR_LENGTH = 2048

/**
 * Validates the query parameters accepted by the agent list endpoint.
 *
 * @remarks Both parameters are optional and unknown parameters are rejected.
 * The numeric `limit` is decoded from its query-string text.
 */
const listAgentsApiQuerySchema = z
  .strictObject({
    /**
     * Opaque continuation returned by the previous page; omission requests
     * the first page.
     */
    cursor: z.string().min(1).max(MAXIMUM_AGENT_LIST_CURSOR_LENGTH).optional(),
    /** Requested page size; omission selects the backend's default page size. */
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAXIMUM_AGENT_LIST_PAGE_SIZE)
      .optional()
  })
  .readonly()

/**
 * Validates one listed agent without its system prompt.
 *
 * @remarks This read projection derives every field from the stored agent
 * contract. Clients read the system prompt through the get-agent endpoint.
 */
const agentSummarySchema = agentSchema
  .unwrap()
  .omit({ systemPrompt: true })
  .readonly()

/**
 * Validates one page of listed agents and its continuation state.
 *
 * @remarks Agents are ordered by `createdAt` ascending, then by `code`
 * ascending, and appear at most once per page. Neither key changes after an
 * agent is created, so an update never moves an agent. Each page observes
 * the store when it is read: an agent deleted after an earlier page was read
 * is absent from later pages, and an agent created since then appears on a
 * later page unless its (`createdAt`, `code`) pair sorts before the cursor's.
 * `nextCursor` is null on the final page.
 */
const listAgentsApiResponseSchema = z
  .strictObject({
    /** Page of listed agents in the documented order. */
    agents: z
      .array(agentSummarySchema)
      .max(MAXIMUM_AGENT_LIST_PAGE_SIZE)
      .readonly(),
    /** Number of stored agents, including those on other pages. */
    storedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Continuation for the next page, or null when this page is final. */
    nextCursor: z
      .string()
      .min(1)
      .max(MAXIMUM_AGENT_LIST_CURSOR_LENGTH)
      .nullable()
  })
  .refine((page) => page.agents.length <= page.storedCount, {
    message: "The agent count must bound the listed page."
  })
  .readonly()

/**
 * Describes the GET endpoint that lists stored agents, oldest first.
 *
 * @remarks The endpoint observes stored data and changes nothing. The shared
 * descriptor is imported by the backend registrar and by the desktop agent
 * adapter, and its response schema by the backend's Sqlite agent records,
 * which validate each page with it. Changing its method, path, query, or
 * response schema changes the transmitted contract and requires coordinated
 * consumers.
 */
export const listAgentsApi = Object.freeze({
  method: "GET",
  path: apiAgentsRoute,
  querystring: listAgentsApiQuerySchema,
  response: listAgentsApiResponseSchema
})

/** Validated query parameters accepted by the agent list endpoint. */
export type ListAgentsApiQuery = z.infer<typeof listAgentsApi.querystring>

/** One listed agent without its system prompt. */
export type AgentSummary = z.infer<typeof agentSummarySchema>

/** One page of listed agents and its continuation state. */
export type ListAgentsApiResponse = z.infer<typeof listAgentsApi.response>

/** Status-specific payloads returned by the agent list endpoint. */
export type ListAgentsApiReply = {
  /** One page of agents in the documented order. */
  readonly 200: ListAgentsApiResponse
}

/** Fastify route type for the agent list endpoint. */
export type ListAgentsApiRoute = {
  /** Validated continuation and page-size parameters. */
  readonly Querystring: ListAgentsApiQuery
  /** Status-specific success payload. */
  readonly Reply: ListAgentsApiReply
}
