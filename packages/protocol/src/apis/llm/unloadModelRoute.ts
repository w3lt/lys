import * as z from "zod"
import {
  llmModelNotFoundProblemSchema,
  llmRuntimeUnavailableProblemSchema,
  llmUnloadFailedProblemSchema
} from "../../http/errors/llm"
import { apiLlmUnloadModelRoute } from "./routes"

/** Validates a non-empty model key requested for unloading. */
export const llmUnloadModelApiRequestBodySchema = z
  .strictObject({
    /** Canonical model key identifying the loaded model to unload. */
    modelId: z.string().min(1)
  })
  .readonly()

/** Validates service-unavailable responses from the model-unload endpoint. */
export const llmUnloadModelApiServiceUnavailableResponseSchema = z.union([
  llmRuntimeUnavailableProblemSchema,
  llmUnloadFailedProblemSchema
])

/** Status-specific error schemas returned by the model-unload endpoint. */
export const llmUnloadModelApiResponseSchemas = Object.freeze({
  404: llmModelNotFoundProblemSchema,
  503: llmUnloadModelApiServiceUnavailableResponseSchema
})

/**
 * Describes the PATCH endpoint that unloads one currently loaded model.
 *
 * @remarks This shared descriptor is imported by the backend route consumer;
 * changing its method, path, body, or response schemas changes the transmitted
 * compatibility contract and requires coordinated consumers.
 */
export const llmUnloadModelApi = Object.freeze({
  method: "PATCH",
  path: apiLlmUnloadModelRoute,
  body: llmUnloadModelApiRequestBodySchema,
  responses: llmUnloadModelApiResponseSchemas
} as const)

/** Request body accepted by the model-unload endpoint. */
export type LlmUnloadModelApiRequestBody = z.infer<
  typeof llmUnloadModelApi.body
>

/** Problem Details body returned when the loaded model cannot be found. */
export type LlmUnloadModelApiNotFoundResponse = z.infer<
  (typeof llmUnloadModelApi.responses)[404]
>

/** Problem Details body returned when the unload operation is unavailable. */
export type LlmUnloadModelApiServiceUnavailableResponse = z.infer<
  (typeof llmUnloadModelApi.responses)[503]
>

/** Status-specific payloads returned by the model-unload endpoint. */
export type LlmUnloadModelApiReply = {
  /** Successful unload response with no payload. */
  readonly 204: undefined
  /** Loaded model was not found. */
  readonly 404: LlmUnloadModelApiNotFoundResponse
  /** Runtime access or the unload operation failed. */
  readonly 503: LlmUnloadModelApiServiceUnavailableResponse
}

/** Fastify route type for the model-unload request and responses. */
export type LlmUnloadModelApiRoute = {
  /** Validated canonical model key supplied to the backend handler. */
  Body: LlmUnloadModelApiRequestBody
  /** Status-specific success and Problem Details payloads. */
  Reply: LlmUnloadModelApiReply
}
