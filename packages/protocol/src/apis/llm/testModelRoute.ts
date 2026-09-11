import * as z from "zod"
import {
  llmServiceBusyProblemSchema,
  type LlmServiceBusyProblem
} from "../../http/errors/llmServiceBusy"
import { apiLlmTestModelRoute } from "./routes"

/** Maximum decoded key length accepted by the Fastify path router. */
const MAX_LLM_MODEL_HEALTH_PATH_PARAMETER_LENGTH = 100

/**
 * Validates the canonical model key selected by the health route path.
 *
 * @remarks The decoded key is limited to 100 characters to match Fastify's
 * effective path-parameter boundary without changing shared router policy.
 */
export const llmTestModelApiParamsSchema = z
  .strictObject({
    /** Canonical model key containing from 1 through 100 decoded characters. */
    modelId: z.string().min(1).max(MAX_LLM_MODEL_HEALTH_PATH_PARAMETER_LENGTH)
  })
  .readonly()

/** Validates a fresh loaded-state observation returned by the health route. */
export const llmTestModelApiResponseSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      /** Canonical model key used for the loaded-state query. */
      modelId: z.string().min(1),
      /** Confirms a fresh valid inventory contained the requested model key. */
      status: z.literal("ready"),
      /** Non-negative safe-integer duration of the accepted health query in milliseconds. */
      latencyMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .readonly(),
  z
    .strictObject({
      /** Canonical model key used for the loaded-state query. */
      modelId: z.string().min(1),
      /** Reports that loaded state was absent or could not be established. */
      status: z.literal("not-ready"),
      /** Stable reason for the negative loaded-state observation. */
      reason: z.enum(["model-not-loaded", "runtime-unavailable"]),
      /** Non-negative safe-integer duration of the accepted health query in milliseconds. */
      latencyMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .readonly()
])

/** Selects the model-health response validator by HTTP status. */
const llmTestModelApiResponseSchemas = Object.freeze({
  200: llmTestModelApiResponseSchema,
  503: llmServiceBusyProblemSchema
})

/**
 * Describes the GET endpoint that observes whether one model is currently loaded.
 *
 * @remarks A 200 response is a fresh inventory observation and is not proof of
 * future inference success. Service-busy responses mean the query was refused
 * before queue acceptance. The backend owns accepted work after disconnect.
 */
export const llmTestModelApi = Object.freeze({
  method: "GET",
  path: apiLlmTestModelRoute,
  params: llmTestModelApiParamsSchema,
  response: llmTestModelApiResponseSchema,
  responses: llmTestModelApiResponseSchemas
})

/** Path parameters containing a canonical model key within the router's decoded length limit. */
export type LlmTestModelApiParams = z.infer<typeof llmTestModelApi.params>

/** Loaded-state observation returned by an accepted health query. */
export type LlmTestModelApiResponse = z.infer<typeof llmTestModelApi.response>

/** Status-specific payloads returned by the model-health endpoint. */
export type LlmTestModelApiReply = {
  /** Fresh loaded-state observation produced by an accepted health query. */
  readonly 200: LlmTestModelApiResponse
  /** The health query was refused before acceptance. */
  readonly 503: LlmServiceBusyProblem
}

/** Fastify route type for model-health parameters and responses. */
export type LlmTestModelApiRoute = {
  /** Validated canonical model key supplied to the backend handler. */
  readonly Params: LlmTestModelApiParams
  /** Status-specific health observation and admission-rejection payloads. */
  readonly Reply: LlmTestModelApiReply
}
