import * as z from "zod"
import {
  FIND_AGENTS_TOOL_NAME,
  READ_AGENT_STATE_TOOL_NAME,
  READ_MY_STATE_TOOL_NAME
} from "./agent"
import { READ_ATTACHMENT_TOOL_NAME } from "./attachment"
import {
  isWithinJsonValueLimits,
  jsonValueSchema,
  MAXIMUM_JSON_NESTING_DEPTH
} from "./json"
import {
  buildMcpToolNamePrefix,
  MCP_TOOL_NAME_PREFIX,
  mcpServerNameSchema
} from "./mcp"
import { hasDistinctValues } from "./values"

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

/** Validates the name a model calls a tool by. */
export const toolNameSchema = z.string().regex(TOOL_NAME_PATTERN)

/** Validates text that tells the model what a tool or an argument does. */
const toolDescriptionSchema = z.string().min(1)

/** Validates the key of one argument in a tool's parameters object. */
export const toolArgumentNameSchema = z
  .string()
  .regex(TOOL_ARGUMENT_NAME_PATTERN)

/**
 * Validates the arguments object of one tool call by its shape only: a JSON
 * object whose keys follow the argument-name rule and whose values are JSON
 * values. The output is frozen all the way down.
 *
 * @remarks The value is checked against the JSON value limits first,
 * without recursion, so the parse that follows is bounded and no key is lost
 * to an object prototype. Values are not checked against a tool's
 * definition; the consumer that knows the tool does that.
 */
export const toolCallArgumentsSchema = z
  .unknown()
  .refine(
    (value) => isWithinJsonValueLimits(value),
    `Arguments nest at most ${MAXIMUM_JSON_NESTING_DEPTH} arrays and objects deep and have no __proto__ key.`
  )
  .pipe(z.record(toolArgumentNameSchema, jsonValueSchema).readonly())

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

/**
 * Validates the group one of Lys's own tools is listed under in Settings.
 *
 * @remarks Only groups that a current tool uses exist. A tool that needs a
 * new group adds it here, and to the desktop's own copy of the definition
 * when a client tool uses it; consumers that branch on the group
 * exhaustively must handle it. MCP tools have their own group, `mcp`.
 */
const lysToolGroupSchema = z.enum([
  "files",
  "network",
  "timeAndPlace",
  "agents"
])

/**
 * Validates what one of Lys's own tools does with the machine it runs on.
 *
 * @remarks `reads` reads data on that machine and sends nothing off it.
 * `network` sends requests off that machine and reads what comes back; a
 * tool with this access starts switched off. Only access levels that a
 * current tool uses exist; a new level is added here, and to the desktop's
 * copy when a client tool uses it. MCP tools have their own access,
 * `unknown`.
 */
const lysToolAccessSchema = z.enum(["reads", "network"])

/**
 * Validates which side of Lys runs one of its own tools.
 *
 * @remarks `client` tools run in the desktop app, which lists them through
 * its `list_tools` command and runs each call itself. `backend` tools run in
 * the backend, which lists them through its tool-list endpoint; the desktop
 * only approves their calls. MCP tools have their own runner, `mcp`.
 */
const lysToolRunnerSchema = z.enum(["client", "backend"])

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
 * Validates one of Lys's own tools: what a model is offered, plus how
 * Settings groups it, what it does with the machine, and which side of Lys
 * runs it. The output is frozen; unknown fields are rejected.
 *
 * @remarks Its name never starts with {@link MCP_TOOL_NAME_PREFIX}, which
 * MCP tools use.
 */
const lysToolDefinitionSchema = z
  .strictObject({
    /** Name the model calls the tool by; also its identity in Settings. */
    name: toolNameSchema.refine(
      (name) => !name.startsWith(MCP_TOOL_NAME_PREFIX),
      `Only MCP tools have names starting with ${MCP_TOOL_NAME_PREFIX}.`
    ),
    /** Text that tells the model what the tool does; Settings shows it too. */
    description: toolDescriptionSchema,
    /** Group the tool is listed under in Settings. */
    group: lysToolGroupSchema,
    /** What the tool does with the machine it runs on. */
    access: lysToolAccessSchema,
    /** Which side of Lys runs the tool. */
    runner: lysToolRunnerSchema,
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
 * Most characters of an MCP tool's description, inclusive; the backend cuts
 * a longer one.
 */
export const MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH = 4096

/** Most characters of the name an MCP server calls one of its tools by. */
export const MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH = 128

/**
 * Validates the shape of an MCP tool's input schema once its nesting was
 * checked.
 */
const mcpToolInputSchemaShapeSchema = z
  .object({
    /** Always `object`: a model sends the arguments as one JSON object. */
    type: z.literal("object"),
    /** Schema of each argument, by argument name; absent when none is described. */
    properties: z
      .record(toolArgumentNameSchema, jsonValueSchema)
      .readonly()
      .optional(),
    /** Names of the arguments a model must send; absent when none is required. */
    required: z.array(toolArgumentNameSchema).readonly().optional()
  })
  .catchall(jsonValueSchema)
  .readonly()

/**
 * Validates the input schema of an MCP tool: a JSON Schema object for the
 * tool's arguments object, as its server gave it. The output is frozen all
 * the way down; keywords other than `type`, `properties`, and `required` are
 * kept as JSON.
 *
 * @remarks `properties` keys and `required` names follow the argument-name
 * rule, so every argument a model sends has a name Lys checks. The whole
 * schema nests at most {@link MAXIMUM_JSON_NESTING_DEPTH} arrays and objects
 * deep and holds no `__proto__` key, checked before its shape so no key is
 * lost while parsing.
 */
const mcpToolInputSchemaSchema = z
  .unknown()
  .refine(
    (value) => isWithinJsonValueLimits(value),
    `An input schema nests at most ${MAXIMUM_JSON_NESTING_DEPTH} arrays and objects deep and has no __proto__ key.`
  )
  .pipe(mcpToolInputSchemaShapeSchema)

/** Input schema of an MCP tool, as the model is offered it. */
export type McpToolInputSchema = z.infer<typeof mcpToolInputSchemaSchema>

/**
 * Validates one tool of a connected MCP server, as the backend lists it. The
 * output is frozen; unknown fields are rejected.
 *
 * @remarks The backend runs every call of it on that server. The model is
 * offered `name`, `description`, and `inputSchema`; `name` is
 * `mcp__<server>__` followed by `serverToolName` with every character
 * outside the tool-name rule replaced by `_`.
 */
const mcpToolDefinitionSchema = z
  .strictObject({
    /** Name the model calls the tool by; also its identity in Settings. */
    name: toolNameSchema,
    /** Text that tells the model what the tool does, from the server. */
    description: z.string().min(1).max(MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH),
    /** Every MCP tool is listed under its server in Settings. */
    group: z.literal("mcp"),
    /** What an MCP tool does depends on its server, which Lys cannot tell. */
    access: z.literal("unknown"),
    /** The backend runs each call on the tool's MCP server. */
    runner: z.literal("mcp"),
    /** Name of the server that runs the tool. */
    server: mcpServerNameSchema,
    /** Name the server calls the tool by. */
    serverToolName: z.string().min(1).max(MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH),
    /** Schema of the tool's arguments object, as the server gave it. */
    inputSchema: mcpToolInputSchemaSchema
  })
  .refine(
    (tool) => tool.name.startsWith(buildMcpToolNamePrefix(tool.server)),
    "An MCP tool's name starts with mcp__<server>__."
  )
  .readonly()

/**
 * Validates one tool: one of Lys's own, or one of a connected MCP server.
 * The output is frozen; unknown fields are rejected.
 *
 * @remarks `runner` selects the variant: `client` and `backend` are Lys's
 * own tools, with a list of arguments; `mcp` is an MCP tool, with its
 * server's input schema. The backend builds an `AgentTool` from it, and both
 * the desktop and the backend list their tools in this shape. The model
 * never receives `group`, `access`, `runner`, or an MCP tool's server
 * fields; {@link buildToolFunctionFormat} leaves them out.
 */
export const toolDefinitionSchema = z.discriminatedUnion("runner", [
  lysToolDefinitionSchema,
  mcpToolDefinitionSchema
])

/**
 * Tool definition before {@link toolDefinitionSchema} validates it; an
 * argument may omit `required`.
 */
export type ToolDefinitionCandidate = z.input<typeof toolDefinitionSchema>

/** Validated, frozen tool definition. */
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>

/** Validated definition of one of Lys's own tools. */
export type LysToolDefinition = z.infer<typeof lysToolDefinitionSchema>

/** Validated definition of one tool of an MCP server. */
export type McpToolDefinition = z.infer<typeof mcpToolDefinitionSchema>

/**
 * Group a tool is listed under in Settings: `files` holds the file tools,
 * `network` the tools that reach past this machine, `timeAndPlace` the tools
 * that tell when and where the person is, `agents` the tools that tell
 * agents about themselves and each other, which the backend adds to a turn
 * itself and Settings does not list, and `mcp` the tools of MCP servers.
 */
export type ToolGroup = ToolDefinition["group"]

/**
 * What a tool does with the machine it runs on: `reads` only reads it,
 * `network` sends requests off it, and `unknown` depends on an MCP server.
 */
export type ToolAccess = ToolDefinition["access"]

/**
 * Which side of Lys runs a tool: the desktop app, the backend, or the
 * backend on an MCP server.
 */
export type ToolRunner = ToolDefinition["runner"]

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
 * Answers whether one side of Lys runs every tool of a list.
 *
 * @param tools - Validated tool definitions; an empty list qualifies.
 * @param runner - Side every tool must name as its runner.
 * @returns True when no tool names another runner.
 */
export function isEveryToolRunBy(
  tools: readonly ToolDefinition[],
  runner: ToolRunner
): boolean {
  return tools.every((tool) => tool.runner === runner)
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

/** Parameters object Lys builds for one of its own tools in the OpenAI format. */
type LysToolParameters = {
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

/**
 * Parameters object of one function tool in the OpenAI format: built from
 * the arguments of one of Lys's own tools, or an MCP tool's input schema as
 * its server gave it.
 */
export type OpenAIFunctionParameters = LysToolParameters | McpToolInputSchema

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
function buildToolArgumentFormat(
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
): LysToolParameters {
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
  } satisfies LysToolParameters)
}

/**
 * Builds the parameters object of one tool.
 *
 * @param definition - Validated tool definition.
 * @returns The object built from a Lys tool's arguments, or an MCP tool's
 * input schema unchanged; deeply frozen either way.
 */
function buildFunctionParameters(
  definition: ToolDefinition
): OpenAIFunctionParameters {
  switch (definition.runner) {
    case "client":
    case "backend":
      return buildToolParameters(definition.arguments)
    case "mcp":
      return definition.inputSchema
  }
}

/**
 * Builds the function tool a model is offered for one tool definition.
 *
 * @param definition - Validated tool definition.
 * @returns A deeply frozen OpenAI function tool. `group`, `access`,
 * `runner`, and an MCP tool's `server` and `serverToolName` are left out,
 * because they describe the tool to the person using Lys and route its
 * calls, not to the model.
 */
export function buildToolFunctionFormat(
  definition: ToolDefinition
): OpenAIFunctionTool {
  const parameters = buildFunctionParameters(definition)
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

/**
 * Names of the tools the backend adds to a turn itself: the attachment reader
 * and the agent tools.
 *
 * @remarks They have no switch, so a chat request may not offer them or name
 * them as switched off or unable to run; the request contract refuses each
 * one before the backend stores anything.
 */
export const BACKEND_INTERNAL_TOOL_NAMES: readonly string[] = Object.freeze([
  READ_ATTACHMENT_TOOL_NAME,
  READ_MY_STATE_TOOL_NAME,
  FIND_AGENTS_TOOL_NAME,
  READ_AGENT_STATE_TOOL_NAME
])
