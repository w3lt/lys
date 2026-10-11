import {
  toolArgumentDefinitionSchema,
  type ToolArgumentDefinition,
  type ToolArgumentDefinitionCandidate
} from "@lys/share"
import * as z from "zod"

/** Value a model may send for one tool argument. */
export type ToolArgumentValue = string | number | boolean

/**
 * Checks the value a model sends for one argument. An argument that is not
 * required also accepts absence.
 */
export type ToolArgumentValueSchema = z.ZodType<ToolArgumentValue | undefined>

/**
 * Owns one validated tool argument to provide the schema that checks the
 * value a model sends for it.
 *
 * @remarks The definition is validated when the argument is created and never
 * changes afterwards. Concurrency model: reentrant; the argument owns no
 * mutable state and retains no collaborator.
 */
export default class ToolArgument {
  /** Validated, frozen definition of the argument. */
  readonly #definition: ToolArgumentDefinition

  /**
   * Creates an argument from its definition.
   *
   * @param definition - Candidate definition; an omitted `required` means
   * `true`.
   * @throws A Zod error when the definition does not match
   * `toolArgumentDefinitionSchema`, such as an enum argument without values.
   */
  public constructor(definition: ToolArgumentDefinitionCandidate) {
    this.#definition = toolArgumentDefinitionSchema.parse(definition)
  }

  /**
   * Returns the argument's key in the tool's arguments object.
   *
   * @returns The validated argument name.
   */
  public get name(): string {
    return this.#definition.name
  }

  /**
   * Builds the schema that checks the value a model sends for this argument.
   *
   * @returns A schema that accepts a string, a finite number, a whole number
   * for `integer`, a Boolean, or one of the listed values for `enum`, as the
   * argument's type says. It also accepts absence when the argument is not
   * required, and rejects every other value.
   */
  public buildValueSchema(): ToolArgumentValueSchema {
    const valueSchema = buildRequiredValueSchema(this.#definition)
    return this.#definition.required ? valueSchema : valueSchema.optional()
  }
}

/**
 * Builds the schema of a value that must be present for one argument.
 *
 * @param definition - Validated argument definition.
 * @returns A schema accepting exactly the values of the argument's type.
 */
function buildRequiredValueSchema(
  definition: ToolArgumentDefinition
): z.ZodType<ToolArgumentValue> {
  switch (definition.type) {
    case "string":
      return z.string()
    case "number":
      return z.number()
    case "integer":
      return z.int()
    case "boolean":
      return z.boolean()
    case "enum":
      return z.enum(definition.values)
  }
}
