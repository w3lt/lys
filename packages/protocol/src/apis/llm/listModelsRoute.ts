import * as z from "zod"
import {
  llmServiceBusyProblemSchema,
  type LlmServiceBusyProblem
} from "../../http/errors/llmServiceBusy"
import {
  llmRuntimeUnavailableProblemSchema,
  type LlmRuntimeUnavailableProblem
} from "../../http/errors/llm"
import { llmInfoSchema } from "./_share"
import { apiLlmListModelsRoute } from "./routes"

/** Validates the complete downloaded-model inventory response. */
export const llmListModelsApiResponseSchema = z
  .strictObject({
    /** Downloaded language models annotated with their current loaded state. */
    llms: z.array(llmInfoSchema).readonly()
  })
  .readonly()

/** Validates service-unavailable responses from the inventory endpoint. */
const llmListModelsApiServiceUnavailableResponseSchema = z.union([
  llmServiceBusyProblemSchema,
  llmRuntimeUnavailableProblemSchema
])

/** Selects the inventory response validator by HTTP status. */
const llmListModelsApiResponseSchemas = Object.freeze({
  200: llmListModelsApiResponseSchema,
  503: llmListModelsApiServiceUnavailableResponseSchema
})

/**
 * Describes the GET endpoint that lists downloaded language models.
 *
 * @remarks This shared descriptor is imported by the backend route consumer;
 * changing its method, path, or response schema changes the transmitted
 * compatibility contract and requires coordinated consumers. Service-busy
 * responses mean the inventory operation was refused before queue acceptance.
 * Runtime-unavailable responses mean the backend has no connected LLM runtime;
 * no inventory query ran, or the runtime stopped answering during it.
 */
export const llmListModelsApi = Object.freeze({
  method: "GET",
  path: apiLlmListModelsRoute,
  responses: llmListModelsApiResponseSchemas
})

/** Response body accepted from the model-list endpoint. */
export type LlmListModelsApiResponse = z.infer<
  typeof llmListModelsApiResponseSchema
>

/** Status-specific payloads returned by the model-list endpoint. */
export type LlmListModelsApiReply = {
  /** Downloaded-model inventory with its observed loaded state. */
  readonly 200: LlmListModelsApiResponse
  /** The inventory was refused before acceptance, or no LLM runtime is connected. */
  readonly 503: LlmServiceBusyProblem | LlmRuntimeUnavailableProblem
}

/** Fastify route type for the model-list response. */
export type LlmListModelsApiRoute = {
  /** Status-specific inventory and service-unavailable payloads. */
  readonly Reply: LlmListModelsApiReply
}
