import type { ChatToolCall } from "@lys/protocol"
import {
  buildToolFunctionFormat,
  toolDefinitionSchema,
  type OpenAIFunctionTool,
  type ToolArgumentDefinition,
  type ToolDefinition,
  type ToolDefinitionCandidate
} from "@lys/share"
import * as z from "zod"
import ToolArgument, {
  type ToolArgumentValue,
  type ToolArgumentValueSchema
} from "./argument"

/** Checked argument values of one tool call, by argument name. */
type ToolCallArguments = ChatToolCall["arguments"]

/** Outcome of checking the argument text a model sent for one tool call. */
export type ToolCallArgumentsResult =
  | Readonly<{
      /** The text is a JSON object that matches the tool's arguments. */
      status: "valid"
      /**
       * Checked values by argument name, as the model sent them; an optional
       * argument the model left out is absent.
       */
      arguments: ToolCallArguments
    }>
  | Readonly<{
      /** The text is not JSON or does not match the tool's arguments. */
      status: "invalid"
      /** Explanation the model reads, naming the tool and each problem. */
      message: string
    }>

/** Outcome of reading a model's argument text as JSON. */
type ArgumentJsonResult =
  | Readonly<{
      /** The text is JSON. */
      status: "parsed"
      /** Untrusted parsed value, which can be any JSON value. */
      value: unknown
    }>
  | Readonly<{
      /** The text is not JSON. */
      status: "unparsable"
    }>

/**
 * Checks a model's arguments object. Its output has no undefined value,
 * because JSON has none, but its type allows one for an optional argument.
 */
type ToolCallArgumentsSchema = z.ZodType<
  Readonly<Record<string, ToolArgumentValue | undefined>>
>

/** Arguments object of a call whose argument text is blank. */
const NO_ARGUMENT_VALUES = Object.freeze({})

/** Reading of blank argument text, which models send for a call without arguments. */
const BLANK_ARGUMENT_JSON = Object.freeze({
  status: "parsed",
  value: NO_ARGUMENT_VALUES
} satisfies ArgumentJsonResult)

/** Reading of argument text that is not JSON. */
const UNPARSABLE_ARGUMENT_JSON = Object.freeze({
  status: "unparsable"
} satisfies ArgumentJsonResult)

/**
 * Owns one validated tool definition to provide the function tool a model is
 * offered and to check the arguments of each call the model makes.
 *
 * @remarks The definition is validated when the tool is created and never
 * changes afterwards; the arguments schema is built from it once. Its `group`
 * and `access` describe the tool to the person using Lys and never reach the
 * model. Concurrency model: reentrant; the tool owns no mutable state and
 * retains no collaborator.
 */
export default class AgentTool {
  /** Validated, frozen definition of the tool. */
  readonly #definition: ToolDefinition
  /** Strict schema of the tool's arguments object, built from the definition. */
  readonly #argumentsSchema: ToolCallArgumentsSchema

  /**
   * Creates a tool from its definition.
   *
   * @param definition - Candidate definition; an argument may omit
   * `required`, which then means `true`.
   * @throws A Zod error when the definition does not match
   * `toolDefinitionSchema`, such as a name a model cannot call or two
   * arguments with the same name.
   */
  public constructor(definition: ToolDefinitionCandidate) {
    this.#definition = toolDefinitionSchema.parse(definition)
    this.#argumentsSchema = buildToolCallArgumentsSchema(this.#definition)
  }

  /**
   * Returns the name the model calls the tool by.
   *
   * @returns The validated tool name.
   */
  public get name(): string {
    return this.#definition.name
  }

  /**
   * Builds the function tool a model is offered for this tool.
   *
   * @returns A deeply frozen OpenAI function tool whose arguments keep their
   * declaration order.
   */
  public buildAgentFormat(): OpenAIFunctionTool {
    return buildToolFunctionFormat(this.#definition)
  }

  /**
   * Checks the argument text a model sent for one call of this tool.
   *
   * @param argumentText - Untrusted text the model wrote for the call's
   * arguments; blank text means no arguments.
   * @returns `valid` with frozen checked values when the text is a JSON
   * object whose keys are declared arguments, with every required argument
   * present and every value of its argument's type. Otherwise `invalid`, with
   * an explanation for the model that names the tool. Bad text never throws.
   */
  public parseCallArguments(argumentText: string): ToolCallArgumentsResult {
    const argumentJson = parseArgumentJson(argumentText)
    if (argumentJson.status === "unparsable")
      return buildInvalidArgumentsResult(
        `The arguments for ${this.name} are not valid JSON.`
      )
    const checkedArguments = this.#argumentsSchema.safeParse(argumentJson.value)
    if (!checkedArguments.success)
      return buildInvalidArgumentsResult(
        `The arguments for ${this.name} do not match the tool:\n${z.prettifyError(checkedArguments.error)}`
      )
    const toolCallArguments = buildToolCallArguments(checkedArguments.data)
    return Object.freeze({ status: "valid", arguments: toolCallArguments })
  }
}

/**
 * Builds the strict schema of one tool's arguments object.
 *
 * @param definition - Validated tool definition.
 * @returns A schema that accepts an object holding only declared arguments,
 * every required one present and every value of its argument's type, and
 * freezes its output.
 */
function buildToolCallArgumentsSchema(
  definition: ToolDefinition
): ToolCallArgumentsSchema {
  const argumentSchemas: Readonly<Record<string, ToolArgumentValueSchema>> =
    Object.fromEntries(definition.arguments.map(buildArgumentSchemaEntry))
  return z.strictObject(argumentSchemas).readonly()
}

/**
 * Builds the schema entry of one argument for a tool's arguments object.
 *
 * @param definition - Validated argument definition.
 * @returns The argument's name and the schema of its value.
 */
function buildArgumentSchemaEntry(
  definition: ToolArgumentDefinition
): [string, ToolArgumentValueSchema] {
  const argument = new ToolArgument(definition)
  return [argument.name, argument.buildValueSchema()]
}

/**
 * Reads a model's argument text as JSON.
 *
 * @param argumentText - Untrusted argument text.
 * @returns The parsed value, an empty object for blank text, or
 * `unparsable` when the text is not JSON.
 * @throws Any failure of `JSON.parse` other than a syntax error, unchanged.
 */
function parseArgumentJson(argumentText: string): ArgumentJsonResult {
  if (argumentText.trim() === "") return BLANK_ARGUMENT_JSON
  try {
    const value: unknown = JSON.parse(argumentText)
    return Object.freeze({ status: "parsed", value })
  } catch (error) {
    if (error instanceof SyntaxError) return UNPARSABLE_ARGUMENT_JSON
    throw error
  }
}

/**
 * Builds the checked arguments of a call from the arguments schema's output.
 *
 * @param argumentValues - Validated values by argument name.
 * @returns A frozen record of the present values.
 */
function buildToolCallArguments(
  argumentValues: Readonly<Record<string, ToolArgumentValue | undefined>>
): ToolCallArguments {
  const presentEntries = Object.entries(argumentValues).filter(
    isPresentArgumentEntry
  )
  return Object.freeze(Object.fromEntries(presentEntries))
}

/**
 * Answers whether an argument entry holds a value.
 *
 * @param entry - Argument name and its validated value.
 * @returns True when the value is not undefined.
 */
function isPresentArgumentEntry(
  entry: [string, ToolArgumentValue | undefined]
): entry is [string, ToolArgumentValue] {
  return entry[1] !== undefined
}

/**
 * Builds the result that explains bad arguments to the model.
 *
 * @param message - Explanation naming the tool and each problem.
 * @returns A frozen `invalid` result.
 */
function buildInvalidArgumentsResult(message: string): ToolCallArgumentsResult {
  return Object.freeze({ status: "invalid", message })
}
