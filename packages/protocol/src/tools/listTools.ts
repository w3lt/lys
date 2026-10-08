import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
import * as z from "zod"

/**
 * Answers whether no two tools share a name.
 *
 * @param tools - Validated tool definitions in list order.
 * @returns True when every tool name appears once.
 */
function hasDistinctToolNames(tools: readonly ToolDefinition[]): boolean {
  return new Set(tools.map((tool) => tool.name)).size === tools.length
}

/**
 * Validates the list that the desktop `list_tools` command returns: every
 * client tool Lys has, each name once, in the order Settings lists them. The
 * output is frozen.
 *
 * @remarks The desktop builds the list from its own copy of the tool
 * definition. A definition that drifts from {@link toolDefinitionSchema},
 * such as one with a field the shared schema lacks, is rejected here.
 */
export const listToolsResultSchema = z
  .array(toolDefinitionSchema)
  .refine(hasDistinctToolNames, "The desktop lists each tool name once.")
  .readonly()

/** Client tools that the desktop `list_tools` command returns, in list order. */
export type ListToolsResult = z.infer<typeof listToolsResultSchema>
