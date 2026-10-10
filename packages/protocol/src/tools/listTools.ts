import {
  hasDistinctToolNames,
  isEveryToolRunBy,
  toolDefinitionSchema,
  type ToolDefinition
} from "@lys/share"
import * as z from "zod"

/**
 * Answers whether every listed tool runs in the desktop app.
 *
 * @param tools - Validated tool definitions in list order.
 * @returns True when every tool's runner is `client`.
 */
function hasOnlyClientTools(tools: readonly ToolDefinition[]): boolean {
  return isEveryToolRunBy(tools, "client")
}

/**
 * Validates the list that the desktop `list_tools` command returns: every
 * client tool Lys has, each name once, in the order Settings lists them. The
 * output is frozen.
 *
 * @remarks The desktop builds the list from its own copy of the tool
 * definition. A definition that drifts from {@link toolDefinitionSchema},
 * such as one with a field the shared schema lacks, is rejected here, and so
 * is a tool whose runner is not `client`.
 */
export const listToolsResultSchema = z
  .array(toolDefinitionSchema)
  .refine(hasDistinctToolNames, "The desktop lists each tool name once.")
  .refine(hasOnlyClientTools, "The desktop lists only client tools.")
  .readonly()

/** Client tools that the desktop `list_tools` command returns, in list order. */
export type ListToolsResult = z.infer<typeof listToolsResultSchema>
