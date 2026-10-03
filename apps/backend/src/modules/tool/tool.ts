import ToolArgument, { type JsonSchemaProperty } from "./argument"
import * as z from "zod"
import { toolArgumentCreationOptionsSchema } from "./argument"

export const agentToolCreationOptionsSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  arguments: z.array(toolArgumentCreationOptionsSchema)
})

export type AgentToolCreationOptions = z.infer<
  typeof agentToolCreationOptionsSchema
>

export interface OpenAIFunctionTool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: {
      type: "object"
      properties: Record<string, JsonSchemaProperty>
      required: string[]
      additionalProperties: false
    }
  }
}

export default class AgentTool {
  #name: string
  #description: string
  #arguments: ToolArgument[]

  public constructor(options: AgentToolCreationOptions) {
    const {
      name,
      description,
      arguments: toolArguments
    } = agentToolCreationOptionsSchema.parse(options)
    this.#name = name
    this.#description = description
    this.#arguments = toolArguments.map((arg) => new ToolArgument(arg))
  }

  public toAgentFormat(): OpenAIFunctionTool {
    const properties: Record<string, JsonSchemaProperty> = {}
    const required: string[] = []

    for (const arg of this.#arguments) {
      properties[arg.name] = arg.toAgentFormat()
      if (arg.required) required.push(arg.name)
    }

    return {
      type: "function",
      function: {
        name: this.#name,
        description: this.#description,
        parameters: {
          type: "object",
          properties,
          required,
          additionalProperties: false
        }
      }
    }
  }
}
