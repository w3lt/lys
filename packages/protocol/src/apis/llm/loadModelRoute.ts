import * as z from "zod"
import { llmInfoSchema } from "./_share"
import { apiLlmLoadModelRoute } from "./routes"

/**
 * Validates the non-empty model identifier requested for loading.
 *
 * The value is passed to LM Studio as a model key or alias; the backend uses
 * LM Studio's canonical `modelKey` in the response and inventory match.
 */
export const llmLoadModelApiRequestBodySchema = z.strictObject({
  /** Model key or alias that LM Studio resolves during loading. */
  modelId: z.string().min(1)
})

export const llmLoadModelApiResponseBodySchema = llmInfoSchema

/**
 * Describes the POST endpoint that loads a model and returns its metadata.
 *
 * @remarks This shared descriptor is imported by the backend route consumer;
 * changing its method, path, body, or response schema changes the transmitted
 * compatibility contract and requires coordinated consumers.
 */
export const llmLoadModelApi = {
  method: "POST",
  path: apiLlmLoadModelRoute,
  body: llmLoadModelApiRequestBodySchema,
  response: llmLoadModelApiResponseBodySchema
}

/** Request body accepted by the model-load endpoint. */
export type LlmLoadModelApiRequestBody = z.infer<typeof llmLoadModelApi.body>

/** Model metadata returned after a successful load. */
export type LlmLoadModelApiResponse = z.infer<typeof llmLoadModelApi.response>

/** Fastify route type for the model-load request and response. */
export type LlmLoadModelApiRoute = {
  /** Validated model identifier supplied to the backend handler. */
  Body: LlmLoadModelApiRequestBody
  /** Model inventory metadata returned by the backend handler. */
  Reply: LlmLoadModelApiResponse
}
