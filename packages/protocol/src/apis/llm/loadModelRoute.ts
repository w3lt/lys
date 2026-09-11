import * as z from "zod"
import {
  llmServiceBusyProblemSchema,
  type LlmServiceBusyProblem
} from "../../http/errors/llmServiceBusy"
import { llmInfoSchema } from "./_share"
import { apiLlmLoadModelRoute } from "./routes"

/**
 * Validates the non-empty model identifier requested for loading.
 *
 * The value is passed to LM Studio as a model key or alias; the backend uses
 * LM Studio's canonical `modelKey` in the response and inventory match.
 */
export const llmLoadModelApiRequestBodySchema = z
  .strictObject({
    /** Model key or alias that LM Studio resolves during loading. */
    modelId: z.string().min(1)
  })
  .readonly()

/** Validates model metadata returned only after a successful load. */
export const llmLoadModelApiResponseBodySchema = llmInfoSchema
  .unwrap()
  .safeExtend({
    /** A successful load response always describes a loaded model. */
    loaded: z.literal(true)
  })
  .readonly()

/** Selects the model-load response validator by HTTP status. */
const llmLoadModelApiResponseSchemas = Object.freeze({
  200: llmLoadModelApiResponseBodySchema,
  503: llmServiceBusyProblemSchema
})

/**
 * Describes the POST endpoint that loads a model and returns its metadata.
 *
 * @remarks This shared descriptor is imported by the backend route consumer;
 * changing its method, path, body, or response schema changes the transmitted
 * compatibility contract and requires coordinated consumers. Service-busy
 * responses mean the load was refused before queue acceptance. Accepted loads
 * continue under the service owner even if the requesting client disconnects.
 */
export const llmLoadModelApi = Object.freeze({
  method: "POST",
  path: apiLlmLoadModelRoute,
  body: llmLoadModelApiRequestBodySchema,
  response: llmLoadModelApiResponseBodySchema,
  responses: llmLoadModelApiResponseSchemas
})

/** Request body accepted by the model-load endpoint. */
export type LlmLoadModelApiRequestBody = z.infer<typeof llmLoadModelApi.body>

/** Model metadata returned after a successful load. */
export type LlmLoadModelApiResponse = z.infer<typeof llmLoadModelApi.response>

/** Status-specific payloads returned by the model-load endpoint. */
export type LlmLoadModelApiReply = {
  /** Metadata of the canonical model after loading completed. */
  readonly 200: LlmLoadModelApiResponse
  /** The load was refused before acceptance. */
  readonly 503: LlmServiceBusyProblem
}

/** Fastify route type for the model-load request and response. */
export type LlmLoadModelApiRoute = {
  /** Validated model identifier supplied to the backend handler. */
  readonly Body: LlmLoadModelApiRequestBody
  /** Status-specific model metadata and admission-rejection payloads. */
  readonly Reply: LlmLoadModelApiReply
}
