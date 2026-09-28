import * as z from "zod"
import {
  llmServiceBusyProblemSchema,
  type LlmServiceBusyProblem
} from "../../http/errors/llmServiceBusy"
import { apiLlmRuntimeConnectRoute, apiLlmRuntimeStatusRoute } from "./routes"

/**
 * Validates the backend's connection status to its LLM runtime.
 *
 * @remarks `connecting` means no attempt has settled since startup or a new
 * runtime is being acquired; `connected` means the latest acquisition or
 * availability probe succeeded; `unreachable` means the latest attempt failed
 * or a held runtime stopped answering. The values are transmitted and not
 * persisted; changing them requires coordinated consumers.
 */
const llmRuntimeConnectionStatusSchema = z.enum([
  "connecting",
  "connected",
  "unreachable"
])

/** Backend connection status to its LLM runtime. */
export type LlmRuntimeConnectionStatus = z.infer<
  typeof llmRuntimeConnectionStatusSchema
>

/** Validates the body returned by both LLM runtime connection endpoints. */
export const llmRuntimeConnectionApiResponseSchema = z
  .strictObject({
    /** Connection status observed when the response was produced. */
    status: llmRuntimeConnectionStatusSchema
  })
  .readonly()

/** Body returned by both LLM runtime connection endpoints. */
type LlmRuntimeConnectionApiResponse = z.infer<
  typeof llmRuntimeConnectionApiResponseSchema
>

/** Selects the runtime-status response validator by HTTP status. */
const llmRuntimeStatusApiResponseSchemas = Object.freeze({
  200: llmRuntimeConnectionApiResponseSchema
})

/**
 * Describes the GET endpoint that reports the backend's LLM runtime connection status.
 *
 * @remarks The backend answers from its in-memory status without contacting
 * the runtime or entering the model-operation queue, so this endpoint has no
 * service-busy response. Changing its method, path, or response schema changes
 * the transmitted contract and requires coordinated consumers.
 */
export const llmRuntimeStatusApi = Object.freeze({
  method: "GET",
  path: apiLlmRuntimeStatusRoute,
  responses: llmRuntimeStatusApiResponseSchemas
})

/** Status-specific payloads returned by the runtime-status endpoint. */
type LlmRuntimeStatusApiReply = {
  /** Connection status at the time of the request. */
  readonly 200: LlmRuntimeConnectionApiResponse
}

/** Fastify route type for the runtime-status response. */
export type LlmRuntimeStatusApiRoute = {
  /** Status-specific runtime-status payloads. */
  readonly Reply: LlmRuntimeStatusApiReply
}

/** Selects the runtime-connect response validator by HTTP status. */
const llmRuntimeConnectApiResponseSchemas = Object.freeze({
  200: llmRuntimeConnectionApiResponseSchema,
  503: llmServiceBusyProblemSchema
})

/**
 * Describes the POST endpoint that connects the backend to its LLM runtime.
 *
 * @remarks A connected backend keeps a runtime that still answers; otherwise
 * it acquires a new one. Concurrent requests share one attempt. The attempt
 * occupies one position in the model-operation queue, so a full queue answers
 * with service-busy Problem Details and starts no attempt. A 200 response
 * carries the settled status, `connected` or `unreachable`. A client that
 * disconnects does not cancel an accepted attempt.
 */
export const llmRuntimeConnectApi = Object.freeze({
  method: "POST",
  path: apiLlmRuntimeConnectRoute,
  responses: llmRuntimeConnectApiResponseSchemas
})

/** Status-specific payloads returned by the runtime-connect endpoint. */
type LlmRuntimeConnectApiReply = {
  /** Settled connection status after the attempt. */
  readonly 200: LlmRuntimeConnectionApiResponse
  /** The attempt was refused before acceptance because the queue was full. */
  readonly 503: LlmServiceBusyProblem
}

/** Fastify route type for the runtime-connect response. */
export type LlmRuntimeConnectApiRoute = {
  /** Status-specific runtime-connect payloads. */
  readonly Reply: LlmRuntimeConnectApiReply
}
