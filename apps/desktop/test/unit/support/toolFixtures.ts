import {
  toolDefinitionSchema,
  type ToolArgumentDefinitionCandidate,
  type ToolDefinition
} from "@lys/share"

/**
 * Builds one client tool definition as the desktop lists it.
 *
 * @param name - Name a model calls the tool by.
 * @param toolArguments - Arguments the tool declares; defaults to one
 * required string `path`.
 * @returns A frozen definition validated by the shared schema.
 */
export function buildToolDefinition(
  name: string,
  toolArguments: readonly ToolArgumentDefinitionCandidate[] = [
    { type: "string", name: "path", description: "Absolute file path." }
  ]
): ToolDefinition {
  return toolDefinitionSchema.parse({
    name,
    description: `Runs ${name}.`,
    group: "files",
    access: "reads",
    arguments: toolArguments
  })
}
