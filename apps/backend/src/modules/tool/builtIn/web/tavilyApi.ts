import type { TavilyApiKey } from "@lys/share"
import * as z from "zod"
import {
  sendTavilyRequest,
  type TavilyRequestDependencies,
  type TavilyRequestFailure
} from "./tavilyRequest"

/** Most results one search asks for and keeps, inclusive. */
export const MAXIMUM_SEARCH_RESULTS = 5

/**
 * Most UTF-16 code units of a trimmed query, inclusive; Lys never sends a
 * longer one.
 */
export const MAXIMUM_SEARCH_QUERY_LENGTH = 400

/** One search to send. */
export type TavilySearchRequest = Readonly<{
  /** Trimmed query, 1 to {@link MAXIMUM_SEARCH_QUERY_LENGTH} code units. */
  query: string
  /** Key the search is sent with; a secret. */
  apiKey: TavilyApiKey
}>

/** One search result as Tavily gave it; untrusted text. */
export type TavilySearchResult = Readonly<{
  /** Title Tavily reported. */
  title: string
  /** URL Tavily reported, not yet checked. */
  url: string
  /** Snippet Tavily chose from the page. */
  content: string
}>

/** Outcome of one search. */
export type TavilySearchOutcome =
  | Readonly<{
      /** Tavily answered. */
      status: "succeeded"
      /** At most {@link MAXIMUM_SEARCH_RESULTS} results, in Tavily's order. */
      results: readonly TavilySearchResult[]
    }>
  | Readonly<{
      /** No usable answer. */
      status: "failed"
      /** Why. */
      failure: TavilyRequestFailure
    }>

/**
 * Plan credits of the key's account, in whole credits: a fraction Tavily
 * reports is rounded up.
 */
export type TavilyAccountCredits = Readonly<{
  /** Credits used this billing cycle. */
  used: number
  /** Credits the plan allows; null when Tavily reports no limit. */
  limit: number | null
}>

/** Outcome of one usage request. */
export type TavilyUsageOutcome =
  | Readonly<{
      /** Tavily accepted the key. */
      status: "succeeded"
      /** Plan credits, or null when the answer does not report them. */
      credits: TavilyAccountCredits | null
    }>
  | Readonly<{
      /** No usable answer. */
      status: "failed"
      /** Why. */
      failure: TavilyRequestFailure
    }>

/**
 * Validates a search answer.
 *
 * @remarks Tavily's answers carry fields Lys never reads (score, images,
 * answer, timing); they are dropped, so nothing but the title, URL, and
 * snippet of each result goes on.
 */
const tavilySearchResponseSchema = z.object({
  results: z.array(
    z.object({ title: z.string(), url: z.string(), content: z.string() })
  )
})

/** Validates a usage answer, which must be an object. */
const tavilyUsageResponseSchema = z.object({ account: z.unknown().optional() })

/**
 * Validates one credit count of a usage answer, a non-negative number, and
 * rounds a fraction up to the next whole credit, so a partly used credit
 * counts as used.
 *
 * @remarks The fraction is not kept. A count past the largest safe integer
 * is refused, because it could not be shown exactly.
 */
const tavilyCreditCountSchema = z
  .number()
  .nonnegative()
  .transform(Math.ceil)
  .pipe(z.int())

/** Validates the plan credits in a usage answer's account. */
const tavilyAccountCreditsSchema = z.object({
  plan_usage: tavilyCreditCountSchema,
  plan_limit: tavilyCreditCountSchema.nullable()
})

/** Failure of an answer whose shape is not Tavily's. */
const UNREADABLE_ANSWER: TavilyRequestFailure = Object.freeze({
  kind: "unreadable"
})

/**
 * Builds the JSON body of a search.
 *
 * @param query - Trimmed query.
 * @returns A basic search for at most {@link MAXIMUM_SEARCH_RESULTS} general
 * results, without Tavily's generated answer, page text, or images: Lys reads
 * pages only through `read_page`, one approval per page.
 */
function buildTavilySearchBody(query: string): string {
  return JSON.stringify({
    query,
    search_depth: "basic",
    max_results: MAXIMUM_SEARCH_RESULTS,
    topic: "general",
    include_answer: false,
    include_raw_content: false,
    include_images: false
  })
}

/**
 * Sends one search to Tavily.
 *
 * @param searchRequest - Query and key.
 * @param abortSignal - Stops the search; borrowed for the call.
 * @param dependencies - Origin, address rule, and time limit.
 * @returns The results, or why there are none: a request failure, or
 * `unreadable` for an answer without Tavily's result shape.
 * @throws The abort reason once `abortSignal` aborts, and any failure Lys
 * does not recognize. A basic search costs one Tavily credit, also when a
 * timeout ends it after Tavily received it.
 */
export async function sendTavilySearchRequest(
  searchRequest: TavilySearchRequest,
  abortSignal: AbortSignal,
  dependencies: TavilyRequestDependencies
): Promise<TavilySearchOutcome> {
  const result = await sendTavilyRequest(
    {
      method: "POST",
      path: "/search",
      apiKey: searchRequest.apiKey,
      body: buildTavilySearchBody(searchRequest.query)
    },
    abortSignal,
    dependencies
  )
  if (result.status === "failed") return result
  const parsed = tavilySearchResponseSchema.safeParse(result.body)
  if (!parsed.success) {
    return Object.freeze({ status: "failed", failure: UNREADABLE_ANSWER })
  }
  const results = Object.freeze(
    parsed.data.results.slice(0, MAXIMUM_SEARCH_RESULTS).map(buildSearchResult)
  )
  return Object.freeze({ status: "succeeded", results })
}

/**
 * Freezes one validated result.
 *
 * @param result - Result the schema accepted.
 * @returns A frozen copy with only its title, URL, and snippet.
 */
function buildSearchResult(
  result: z.infer<typeof tavilySearchResponseSchema>["results"][number]
): TavilySearchResult {
  return Object.freeze({
    title: result.title,
    url: result.url,
    content: result.content
  })
}

/**
 * Asks Tavily about a key's usage, which checks the key without searching.
 *
 * @param apiKey - Key to check; a secret.
 * @param abortSignal - Stops the request; borrowed for the call.
 * @param dependencies - Origin, address rule, and time limit.
 * @returns `succeeded` with the plan credits when the answer reports them,
 * each rounded up to a whole credit, or why there is no usable answer.
 * @throws The abort reason once `abortSignal` aborts, and any failure Lys
 * does not recognize.
 */
export async function sendTavilyUsageRequest(
  apiKey: TavilyApiKey,
  abortSignal: AbortSignal,
  dependencies: TavilyRequestDependencies
): Promise<TavilyUsageOutcome> {
  const result = await sendTavilyRequest(
    { method: "GET", path: "/usage", apiKey },
    abortSignal,
    dependencies
  )
  if (result.status === "failed") return result
  const parsed = tavilyUsageResponseSchema.safeParse(result.body)
  if (!parsed.success) {
    return Object.freeze({ status: "failed", failure: UNREADABLE_ANSWER })
  }
  const credits = tavilyAccountCreditsSchema.safeParse(parsed.data.account)
  if (!credits.success)
    return Object.freeze({ status: "succeeded", credits: null })
  const accountCredits: TavilyAccountCredits = Object.freeze({
    used: credits.data.plan_usage,
    limit: credits.data.plan_limit
  })
  return Object.freeze({ status: "succeeded", credits: accountCredits })
}
