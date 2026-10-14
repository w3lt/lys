import {
  hasDistinctToolNames,
  isEveryToolRunBy,
  toolDefinitionSchema,
  type ToolDefinition
} from "@lys/share"
import * as z from "zod"
import { unavailableBackendToolSchema } from "./backendToolAvailability"
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

/** Validates the two lists of the response before their combined checks. */
const listedBackendToolsSchema = z.strictObject({
  /** Every tool the backend runs; may be empty. */
  tools: z
    .array(toolDefinitionSchema)
    .refine(hasDistinctToolNames, "The backend lists each tool name once.")
    .refine(hasOnlyBackendTools, "The backend lists only backend tools.")
    .readonly(),
  /** Listed tools that cannot run now, each once, in list order. */
  unavailableTools: z.array(unavailableBackendToolSchema).readonly()
})

/** Both lists of the response, before their combined checks. */
type ListedBackendTools = z.infer<typeof listedBackendToolsSchema>

/**
 * Answers whether no unavailable tool is named twice.
 *
 * @param list - Validated tool list.
 * @returns True when every unavailable tool's name appears once.
 */
function hasDistinctUnavailableToolNames(list: ListedBackendTools): boolean {
  const names = list.unavailableTools.map((tool) => tool.name)
  return new Set(names).size === names.length
}

/**
 * Answers whether every unavailable tool is a listed tool.
 *
 * @param list - Validated tool list.
 * @returns True when each unavailable tool's name is the name of a listed
 * tool.
 */
function hasOnlyListedUnavailableTools(list: ListedBackendTools): boolean {
  const listedNames = new Set(list.tools.map((tool) => tool.name))
  return list.unavailableTools.every((tool) => listedNames.has(tool.name))
}

/**
 * Validates the list of tools the backend runs: each name once, every runner
 * `backend`, in the order Settings lists them, with the listed tools that
 * cannot run now and why. The output is frozen.
 */
export const listBackendToolsApiResponseSchema = listedBackendToolsSchema
  .refine(
    hasDistinctUnavailableToolNames,
    "The backend names each unavailable tool once."
  )
  .refine(
    hasOnlyListedUnavailableTools,
    "The backend names only listed tools as unavailable."
  )
  .readonly()

/** Selects the tool-list response validator by HTTP status. */
const listBackendToolsApiResponseSchemas = Object.freeze({
  200: listBackendToolsApiResponseSchema
})

/**
 * Describes the GET endpoint that lists the tools the backend runs.
 *
 * @remarks The definitions are fixed for one backend build. Availability is
 * read again on every request, so saving or removing the Tavily API key shows
 * on the next read. The desktop shows these tools in Settings beside its own
 * client tools and offers the switched-on, available ones by name with each
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
