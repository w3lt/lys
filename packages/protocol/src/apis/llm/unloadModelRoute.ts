import * as z from "zod"
import {
  llmModelNotFoundProblemSchema,
  llmRuntimeUnavailableProblemSchema,
  llmUnloadFailedProblemSchema
} from "../../http/errors/llm"
import { llmServiceBusyProblemSchema } from "../../http/errors/llmServiceBusy"
import { apiLlmUnloadModelRoute } from "./routes"

/** Validates a non-empty model key whose loaded instances should be stopped. */
export const llmUnloadModelApiRequestBodySchema = z
  .strictObject({
    /** Canonical model key shared by every loaded instance to stop. */
    modelId: z.string().min(1)
  })
  .readonly()

/** Validates service-unavailable responses from the model-unload endpoint. */
export const llmUnloadModelApiServiceUnavailableResponseSchema = z.union([
  llmRuntimeUnavailableProblemSchema,
  llmUnloadFailedProblemSchema,
  llmServiceBusyProblemSchema
])

/** Selects the model-unload error validator by HTTP status. */
export const llmUnloadModelApiResponseSchemas = Object.freeze({
  404: llmModelNotFoundProblemSchema,
  503: llmUnloadModelApiServiceUnavailableResponseSchema
})

/**
 * Describes the PATCH endpoint that stops every loaded instance matching one model key.
 *
 * @remarks This shared descriptor is imported by the backend route consumer;
 * changing its method, path, body, or response schemas changes the transmitted
 * compatibility contract and requires coordinated consumers. Success means a
 * reconciliation snapshot found no matching instance; another runtime client
 * may load a new matching instance afterward. Service-busy responses mean the
 * unload was refused before queue acceptance. Accepted unloads continue under
 * the service owner even if the requesting client disconnects.
 */
export const llmUnloadModelApi = Object.freeze({
  method: "PATCH",
  path: apiLlmUnloadModelRoute,
  body: llmUnloadModelApiRequestBodySchema,
  responses: llmUnloadModelApiResponseSchemas
})

/** Request body accepted by the model-unload endpoint. */
export type LlmUnloadModelApiRequestBody = z.infer<
  typeof llmUnloadModelApi.body
>

/** Problem Details body returned when the loaded model cannot be found. */
export type LlmUnloadModelApiNotFoundResponse = z.infer<
  typeof llmModelNotFoundProblemSchema
>

/** Problem Details body returned for refused admission or an unavailable unload. */
export type LlmUnloadModelApiServiceUnavailableResponse = z.infer<
  typeof llmUnloadModelApiServiceUnavailableResponseSchema
>

/** Status-specific payloads returned by the model-unload endpoint. */
export type LlmUnloadModelApiReply = {
  /** Reconciliation found no loaded instance matching the requested key. */
  readonly 204: undefined
  /** Loaded model was not found. */
  readonly 404: LlmUnloadModelApiNotFoundResponse
  /** Admission was refused, runtime access failed, or the unload failed. */
  readonly 503: LlmUnloadModelApiServiceUnavailableResponse
}

/** Fastify route type for the model-unload request and responses. */
export type LlmUnloadModelApiRoute = {
  /** Validated canonical model key supplied to the backend handler. */
  readonly Body: LlmUnloadModelApiRequestBody
  /** Status-specific success and Problem Details payloads. */
  readonly Reply: LlmUnloadModelApiReply
}
