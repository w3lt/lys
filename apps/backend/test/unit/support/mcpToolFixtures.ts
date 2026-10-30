import { toolDefinitionSchema, type McpToolDefinition } from "@lys/share"

/**
 * Validates the definition of one MCP tool.
 *
 * @param candidate - Definition before validation.
 * @returns The frozen definition.
 * @throws When the candidate is not a valid tool definition, or is one of
 * Lys's own tools.
 */
export function parseMcpToolDefinition(candidate: unknown): McpToolDefinition {
  const definition = toolDefinitionSchema.parse(candidate)
  if (definition.runner !== "mcp")
    throw new Error(`${definition.name} is not an MCP tool`)
  return definition
}
