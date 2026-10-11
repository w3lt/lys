import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"

/**
 * Validated definition of the desktop's read-text-file tool: one required
 * string argument, `path`.
 */
export const READ_TEXT_FILE_TOOL: ToolDefinition = toolDefinitionSchema.parse({
  name: "read_text_file",
  description: "Read one UTF-8 text file and return its complete text.",
  group: "files",
  access: "reads",
  runner: "client",
  arguments: [
    { type: "string", name: "path", description: "Absolute path of the file." }
  ]
})

/** Function tool a model is offered for {@link READ_TEXT_FILE_TOOL}. */
export const READ_TEXT_FILE_FORMAT = Object.freeze({
  type: "function",
  function: {
    name: "read_text_file",
    description: "Read one UTF-8 text file and return its complete text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file." }
      },
      required: ["path"],
      additionalProperties: false
    }
  }
})
