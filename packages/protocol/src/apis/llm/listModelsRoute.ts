import * as z from "zod"
import {
  llmServiceBusyProblemSchema,
  type LlmServiceBusyProblem
} from "../../http/errors/llmServiceBusy"
import {
  llmRuntimeUnavailableProblemSchema,
  type LlmRuntimeUnavailableProblem
} from "../../http/errors/llm"
import {
  llmInfoSchema,
  llmProviderApiParamsSchema,
  type LlmProviderApiParams
} from "./_share"
import { apiLlmListModelsRoute } from "./routes"

/**
 * Validates who loads the models of a provider.
 *
 * @remarks `lys`: a model answers only once loaded, and the person loads and
 * unloads models through the load and unload endpoints. `provider`: the
 * provider decides which models are in memory, so the load and unload
 * endpoints refuse with status 409, and a listed model is loaded while the
 * provider serves it: every model of a hosted provider, and the models a
 * local Ollama server is running. The values
 * are transmitted and not persisted; changing them requires coordinated
 * consumers.
 */
export const llmModelLoadingSchema = z.enum(["lys", "provider"])

/** Who loads the models of a provider. */
export type LlmModelLoading = z.infer<typeof llmModelLoadingSchema>

/** Validates one provider's complete model inventory response. */
export const llmListModelsApiResponseSchema = z
  .strictObject({
    /** Downloaded language models annotated with their current loaded state. */
    llms: z.array(llmInfoSchema).readonly(),
    /** Who loads the listed models, observed with them. */
    modelLoading: llmModelLoadingSchema
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
 * Describes the GET endpoint that lists one provider's language models.
 *
 * @remarks This shared descriptor is imported by the backend route consumer;
 * changing its method, path, or response schema changes the transmitted
 * compatibility contract and requires coordinated consumers. Service-busy
 * responses mean the inventory operation was refused before queue acceptance.
 * Runtime-unavailable responses mean the backend has no connected runtime for
 * the provider, which is the case while it is off; no inventory query ran, or
 * the runtime stopped answering during it.
 */
export const llmListModelsApi = Object.freeze({
  method: "GET",
  path: apiLlmListModelsRoute,
  params: llmProviderApiParamsSchema,
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

/** Fastify route type for the model-list request and response. */
export type LlmListModelsApiRoute = {
  /** Validated provider the inventory is read from. */
  readonly Params: LlmProviderApiParams
  /** Status-specific inventory and service-unavailable payloads. */
  readonly Reply: LlmListModelsApiReply
}
