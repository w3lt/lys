import * as z from "zod"
import { llmInfoSchema } from "./_share"
import { apiLlmListModelsRoute } from "./routes"

/** Validates the complete downloaded-model inventory response. */
export const llmListModelsApiResponseSchema = z.strictObject({
  /** Downloaded language models annotated with their current loaded state. */
  llms: z.array(llmInfoSchema)
})

/**
 * Describes the GET endpoint that lists downloaded language models.
 *
 * @remarks This shared descriptor is imported by the backend route consumer;
 * changing its method, path, or response schema changes the transmitted
 * compatibility contract and requires coordinated consumers.
 */
export const llmListModelsApi = {
  method: "GET",
  path: apiLlmListModelsRoute,
  response: llmListModelsApiResponseSchema
} as const

/** Response body accepted from the model-list endpoint. */
export type LlmListModelsApiResponse = z.infer<typeof llmListModelsApi.response>

/** Fastify route type for the model-list response. */
export type LlmListModelsApiRoute = {
  /** Validated response payload returned by the backend handler. */
  Reply: LlmListModelsApiResponse
}
