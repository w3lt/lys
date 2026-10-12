import * as z from "zod"
import { backendToolUnavailableReasonSchema } from "./backendToolAvailability"
import { apiWebSearchKeyCheckRoute } from "./routes"

/**
 * Validates the plan credits Tavily reports for the key's account. The
 * output is frozen.
 */
const tavilyCreditUsageSchema = z
  .strictObject({
    /** Credits used in the current billing cycle. */
    used: z.int().nonnegative(),
    /** Credits the plan allows per cycle; null when Tavily reports no limit. */
    limit: z.int().nonnegative().nullable()
  })
  .readonly()

/** Plan credits Tavily reports for the key's account. */
export type TavilyCreditUsage = z.infer<typeof tavilyCreditUsageSchema>

/**
 * Validates why a key check could not tell whether the key works: Tavily
 * limited requests, the check timed out, Tavily could not be reached, Tavily
 * answered with an error, or its answer could not be read.
 */
const webSearchKeyCheckFailureSchema = z.enum([
  "rate-limited",
  "timed-out",
  "unreachable",
  "provider-error",
  "invalid-response"
])

/** Why a key check could not tell whether the key works. */
export type WebSearchKeyCheckFailure = z.infer<
  typeof webSearchKeyCheckFailureSchema
>

/**
 * Validates the outcome of checking the saved Tavily API key. The output is
 * frozen.
 *
 * @remarks `accepted`: Tavily accepted the key just now, with the plan
 * credits when it reported them. `rejected`: Tavily refused the key.
 * `unavailable`: no usable key is saved, so nothing was sent. `failed`: the
 * check could not tell. The answer never contains the key.
 */
export const checkWebSearchKeyApiResponseSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("accepted"),
      /** Plan credits, or null when Tavily did not report them. */
      credits: tavilyCreditUsageSchema.nullable()
    }),
    z.strictObject({ status: z.literal("rejected") }),
    z.strictObject({
      status: z.literal("unavailable"),
      /** Why no key was sent. */
      reason: backendToolUnavailableReasonSchema
    }),
    z.strictObject({
      status: z.literal("failed"),
      /** Why the check could not tell. */
      reason: webSearchKeyCheckFailureSchema
    })
  ])
  .readonly()

/** Selects the key-check response validator by HTTP status. */
const checkWebSearchKeyApiResponseSchemas = Object.freeze({
  200: checkWebSearchKeyApiResponseSchema
})

/**
 * Describes the GET endpoint that checks the saved Tavily API key with
 * Tavily.
 *
 * @remarks The backend reads the key from the settings file and asks
 * Tavily's usage endpoint about it; it changes nothing. A check ends within
 * the Tavily request time limit and is not cancelled when the client leaves.
 * Changing the method, path, or response schema changes the transmitted
 * compatibility contract and requires coordinated consumers.
 */
export const checkWebSearchKeyApi = Object.freeze({
  method: "GET",
  path: apiWebSearchKeyCheckRoute,
  responses: checkWebSearchKeyApiResponseSchemas
})

/** Outcome of checking the saved Tavily API key. */
export type CheckWebSearchKeyApiResponse = z.infer<
  typeof checkWebSearchKeyApiResponseSchema
>

/** Status-specific payloads returned by the key-check endpoint. */
export type CheckWebSearchKeyApiReply = {
  /** Outcome of the check. */
  readonly 200: CheckWebSearchKeyApiResponse
}

/** Fastify route type for the key-check endpoint. */
export type CheckWebSearchKeyApiRoute = {
  /** Status-specific key-check payload. */
  readonly Reply: CheckWebSearchKeyApiReply
}
