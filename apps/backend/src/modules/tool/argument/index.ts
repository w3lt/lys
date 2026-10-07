import * as z from "zod"

export const toolArgumentTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean"
])

export type ToolArgumentType = z.infer<typeof toolArgumentTypeSchema>

export const toolArgumentCreationOptionsSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    type: toolArgumentTypeSchema,
    required: z.boolean().default(true)
  })
  .readonly()

export type ToolArgumentCreationOptions = z.infer<
  typeof toolArgumentCreationOptionsSchema
>

export interface JsonSchemaProperty {
  type: ToolArgumentType
  description: string
}

export default class ToolArgument {
  /** Non-empty key of the argument in the tool's parameters object. */
  readonly #name: string
  /** Non-empty text that tells the model what the argument means. */
  readonly #description: string
  /** JSON Schema type that the argument's value must have. */
  readonly #type: ToolArgumentType
  /** Whether the model must supply the argument. */
  readonly #required: boolean

  public constructor(options: ToolArgumentCreationOptions) {
    const { name, description, type, required } =
      toolArgumentCreationOptionsSchema.parse(options)
    this.#name = name
    this.#description = description
    this.#type = type
    this.#required = required
  }

  public get name(): string {
    return this.#name
  }

  public get description(): string {
    return this.#description
  }
  public get type(): ToolArgumentType {
    return this.#type
  }

  public get required(): boolean {
    return this.#required
  }

  public toAgentFormat(): JsonSchemaProperty {
    return {
      type: this.#type,
      description: this.#description
    }
  }
}
