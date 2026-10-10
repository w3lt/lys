import {
  hasDistinctToolNames,
  isEveryToolRunBy,
  toolDefinitionSchema,
  type ToolDefinition
} from "@lys/share"
import * as z from "zod"
import { apiToolsRoute } from "./routes"

/**
 * Answers whether every listed tool runs in the backend.
 *
 * @param tools - Validated tool definitions in list order.
 * @returns True when every tool's runner is `backend`.
 */
function hasOnlyBackendTools(tools: readonly ToolDefinition[]): boolean {
  return isEveryToolRunBy(tools, "backend")
}

/**
 * Validates the list of tools the backend runs: each name once, every runner
 * `backend`, in the order Settings lists them. The output is frozen.
 */
export const listBackendToolsApiResponseSchema = z
  .strictObject({
    /** Every tool the backend runs; may be empty. */
    tools: z
      .array(toolDefinitionSchema)
      .refine(hasDistinctToolNames, "The backend lists each tool name once.")
      .refine(hasOnlyBackendTools, "The backend lists only backend tools.")
      .readonly()
  })
  .readonly()

/** Selects the tool-list response validator by HTTP status. */
const listBackendToolsApiResponseSchemas = Object.freeze({
  200: listBackendToolsApiResponseSchema
})

/**
 * Describes the GET endpoint that lists the tools the backend runs.
 *
 * @remarks The list is fixed for one backend build, so a repeated read
 * returns the same tools. The desktop shows these tools in Settings beside
 * its own client tools and offers the switched-on ones by name with each
 * chat request. Changing the method, path, or response schema changes the
 * transmitted compatibility contract and requires coordinated consumers.
 */
export const listBackendToolsApi = Object.freeze({
  method: "GET",
  path: apiToolsRoute,
  responses: listBackendToolsApiResponseSchemas
})

/** Response body of the backend tool-list endpoint. */
export type ListBackendToolsApiResponse = z.infer<
  typeof listBackendToolsApiResponseSchema
>

/** Status-specific payloads returned by the backend tool-list endpoint. */
export type ListBackendToolsApiReply = {
  /** Every tool the backend runs. */
  readonly 200: ListBackendToolsApiResponse
}

/** Fastify route type for the backend tool-list endpoint. */
export type ListBackendToolsApiRoute = {
  /** Status-specific tool-list payload. */
  readonly Reply: ListBackendToolsApiReply
}
