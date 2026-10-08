import * as z from "zod"

/**
 * Function names the OpenAI function-tool format accepts: 1 to 64 ASCII
 * letters, digits, underscores, or hyphens.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Argument names a tool may declare: an ASCII letter followed by up to 63
 * ASCII letters, digits, or underscores.
 *
 * @remarks The leading letter keeps out `__proto__` and integer-like names,
 * so the parameters object a model receives never touches an object
 * prototype and lists the arguments in declaration order.
 */
const TOOL_ARGUMENT_NAME_PATTERN = /^[A-Za-z]\w{0,63}$/

/**
 * Answers whether every value in a list appears once.
 *
 * @param values - Values to inspect, compared exactly.
 * @returns True when no value repeats.
 */
function hasDistinctValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/** Validates the name a model calls a tool by. */
export const toolNameSchema = z.string().regex(TOOL_NAME_PATTERN)

/** Validates text that tells the model what a tool or an argument does. */
const toolDescriptionSchema = z.string().min(1)

/** Validates the key of one argument in a tool's parameters object. */
export const toolArgumentNameSchema = z
  .string()
  .regex(TOOL_ARGUMENT_NAME_PATTERN)

/** Validates whether a model must supply an argument; omission means `true`. */
const toolArgumentRequiredSchema = z.boolean().default(true)

/**
 * Validates the values an enum argument accepts: at least one, each
 * non-empty and listed once, in the order the model is offered them.
 */
const toolArgumentValuesSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine(hasDistinctValues, "An enum argument lists each value once.")
  .readonly()

/**
 * Validates an argument whose value is any JSON string, number, integer, or
 * Boolean.
 */
const scalarToolArgumentSchema = z
  .strictObject({
    /** JSON Schema type of the value the model supplies. */
    type: z.enum(["string", "number", "integer", "boolean"]),
    /** Key of the argument in the tool's parameters object. */
    name: toolArgumentNameSchema,
    /** Text that tells the model what the argument means. */
    description: toolDescriptionSchema,
    /** Whether the model must supply the argument; omitted means `true`. */
    required: toolArgumentRequiredSchema
  })
  .readonly()

/** Validates an argument whose value is one of a listed set of strings. */
const enumToolArgumentSchema = z
  .strictObject({
    /** The value is one of `values`; the model sends it as a JSON string. */
    type: z.literal("enum"),
    /** Key of the argument in the tool's parameters object. */
    name: toolArgumentNameSchema,
    /** Text that tells the model what the argument means. */
    description: toolDescriptionSchema,
    /** Whether the model must supply the argument; omitted means `true`. */
    required: toolArgumentRequiredSchema,
    /** Every value the argument accepts, in the order offered to the model. */
    values: toolArgumentValuesSchema
  })
  .readonly()

/**
 * Validates one argument of a tool definition. The output is frozen; unknown
 * fields are rejected.
 *
 * @remarks `type` selects the variant. `string`, `number`, `integer`, and
 * `boolean` accept any value of that JSON type. `enum` accepts only the
 * listed `values`, which only an enum argument carries; a model receives it
 * as a JSON string limited to them, because JSON Schema has no enum type.
 */
export const toolArgumentDefinitionSchema = z.discriminatedUnion("type", [
  scalarToolArgumentSchema,
  enumToolArgumentSchema
])

/**
 * Argument of a tool definition before {@link toolArgumentDefinitionSchema}
 * validates it; `required` may be omitted.
 */
export type ToolArgumentDefinitionCandidate = z.input<
  typeof toolArgumentDefinitionSchema
>

/** Validated, frozen argument of a tool definition. */
export type ToolArgumentDefinition = z.infer<
  typeof toolArgumentDefinitionSchema
>

/** Type of the value a model supplies for one argument. */
export type ToolArgumentType = ToolArgumentDefinition["type"]

/**
 * Validates the group a tool is listed under in Settings.
 *
 * @remarks Only groups that a current tool uses exist. A tool that needs a
 * new group adds it here and to the desktop's own copy of the definition;
 * consumers that branch on the group exhaustively must handle it.
 */
const toolGroupSchema = z.enum(["files"])

/** Group a tool is listed under in Settings: `files` holds the file tools. */
export type ToolGroup = z.infer<typeof toolGroupSchema>

/**
 * Validates what a tool does with the machine it runs on.
 *
 * @remarks `reads` reads data on that machine and sends nothing off it. Only
 * access levels that a current tool uses exist; a tool that sends data off
 * the machine adds its own level here and to the desktop's copy, and starts
 * switched off.
 */
const toolAccessSchema = z.enum(["reads"])

/** What a tool does with the machine it runs on. */
export type ToolAccess = z.infer<typeof toolAccessSchema>

/**
 * Answers whether no two arguments of a tool share a name.
 *
 * @param toolArguments - Validated arguments in declaration order.
 * @returns True when every argument name appears once.
 */
function hasDistinctArgumentNames(
  toolArguments: readonly ToolArgumentDefinition[]
): boolean {
  return hasDistinctValues(toolArguments.map((argument) => argument.name))
}

/**
 * Validates one tool: what a model is offered, plus how Settings groups it
 * and what it does with the machine. The output is frozen; unknown fields
 * are rejected.
 *
 * @remarks The backend builds an `AgentTool` from it, and the desktop lists
 * its client tools in this shape. The model never receives `group` or
 * `access`; {@link buildToolFunctionFormat} leaves them out.
 */
export const toolDefinitionSchema = z
  .strictObject({
    /** Name the model calls the tool by; also its identity in Settings. */
    name: toolNameSchema,
    /** Text that tells the model what the tool does; Settings shows it too. */
    description: toolDescriptionSchema,
    /** Group the tool is listed under in Settings. */
    group: toolGroupSchema,
    /** What the tool does with the machine it runs on. */
    access: toolAccessSchema,
    /** Arguments in declaration order, each name once; may be empty. */
    arguments: z
      .array(toolArgumentDefinitionSchema)
      .refine(
        hasDistinctArgumentNames,
        "A tool declares each argument name once."
      )
      .readonly()
  })
  .readonly()

/**
 * Tool definition before {@link toolDefinitionSchema} validates it; an
 * argument may omit `required`.
 */
export type ToolDefinitionCandidate = z.input<typeof toolDefinitionSchema>

/** Validated, frozen tool definition. */
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>

/**
 * Answers whether no two tools share a name.
 *
 * @param tools - Validated tool definitions in list order.
 * @returns True when every tool name appears once.
 */
export function hasDistinctToolNames(
  tools: readonly ToolDefinition[]
): boolean {
  return hasDistinctValues(tools.map((tool) => tool.name))
}

/**
 * JSON Schema of one parameter in the OpenAI function-tool format.
 *
 * @remarks This is the external shape a model receives. JSON Schema allows
 * `enum` on any type; Lys sets it only on `string` parameters built from an
 * enum argument, and leaves it out otherwise.
 */
export type JsonSchemaProperty = {
  /** JSON Schema type of the value. */
  readonly type: "string" | "number" | "integer" | "boolean"
  /** Text that tells the model what the parameter means. */
  readonly description: string
  /** Every value the parameter accepts; absent when any value is accepted. */
  readonly enum?: readonly string[]
}

/** Parameters object of one function tool in the OpenAI format. */
export type OpenAIFunctionParameters = {
  /** Always `object`: a model sends the arguments as one JSON object. */
  readonly type: "object"
  /**
   * Parameter schemas keyed by argument name, in declaration order. The plain
   * object is the external format's own representation.
   */
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>
  /** Names of the arguments a model must supply, in declaration order. */
  readonly required: readonly string[]
  /** Always `false`: a model may not send arguments the tool lacks. */
  readonly additionalProperties: false
}

/** Function a model may call, in the OpenAI function-tool format. */
export type OpenAIFunction = {
  /** Name the model calls the function by. */
  readonly name: string
  /** Text that tells the model what the function does. */
  readonly description: string
  /** Arguments the function accepts. */
  readonly parameters: OpenAIFunctionParameters
}

/** One tool in the OpenAI function-tool format, as a model is offered it. */
export type OpenAIFunctionTool = {
  /** Always `function`: every Lys tool is a function tool. */
  readonly type: "function"
  /** Function the model may call. */
  readonly function: OpenAIFunction
}

/**
 * Builds the JSON Schema a model receives for one tool argument.
 *
 * @param argument - Validated argument definition.
 * @returns A frozen schema. An enum argument becomes a string limited to its
 * values; any other argument keeps its own type.
 */
export function buildToolArgumentFormat(
  argument: ToolArgumentDefinition
): JsonSchemaProperty {
  switch (argument.type) {
    case "enum":
      return Object.freeze({
        type: "string",
        description: argument.description,
        enum: argument.values
      } satisfies JsonSchemaProperty)
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return Object.freeze({
        type: argument.type,
        description: argument.description
      } satisfies JsonSchemaProperty)
  }
}

/**
 * Builds the parameters object of one function tool from its arguments.
 *
 * @param toolArguments - Validated arguments in declaration order, each name
 * once.
 * @returns A deeply frozen parameters object that keeps declaration order in
 * both `properties` and `required`.
 */
function buildToolParameters(
  toolArguments: readonly ToolArgumentDefinition[]
): OpenAIFunctionParameters {
  const properties = Object.freeze(
    Object.fromEntries(
      toolArguments.map((argument) => [
        argument.name,
        buildToolArgumentFormat(argument)
      ])
    )
  )
  const required = Object.freeze(
    toolArguments
      .filter((argument) => argument.required)
      .map((argument) => argument.name)
  )

  return Object.freeze({
    type: "object",
    properties,
    required,
    additionalProperties: false
  } satisfies OpenAIFunctionParameters)
}

/**
 * Builds the function tool a model is offered for one tool definition.
 *
 * @param definition - Validated tool definition.
 * @returns A deeply frozen OpenAI function tool. `group` and `access` are left
 * out, because they describe the tool to the person using Lys, not to the
 * model.
 */
export function buildToolFunctionFormat(
  definition: ToolDefinition
): OpenAIFunctionTool {
  const parameters = buildToolParameters(definition.arguments)
  const toolFunction = Object.freeze({
    name: definition.name,
    description: definition.description,
    parameters
  } satisfies OpenAIFunction)

  return Object.freeze({
    type: "function",
    function: toolFunction
  } satisfies OpenAIFunctionTool)
}
