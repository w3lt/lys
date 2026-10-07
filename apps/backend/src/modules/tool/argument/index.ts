import {
  buildToolArgumentFormat,
  toolArgumentDefinitionSchema,
  type JsonSchemaProperty,
  type ToolArgumentDefinition,
  type ToolArgumentDefinitionCandidate,
  type ToolArgumentType
} from "@lys/share"

/**
 * Owns one validated tool argument to provide the JSON Schema a model
 * receives for it.
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
   * Returns the argument's key in the tool's parameters object.
   *
   * @returns The validated argument name.
   */
  public get name(): string {
    return this.#definition.name
  }

  /**
   * Returns the text that tells the model what the argument means.
   *
   * @returns The validated, non-empty description.
   */
  public get description(): string {
    return this.#definition.description
  }

  /**
   * Returns the type of the value a model supplies.
   *
   * @returns The argument type; `enum` limits the value to listed strings.
   */
  public get type(): ToolArgumentType {
    return this.#definition.type
  }

  /**
   * Returns whether a model must supply the argument.
   *
   * @returns True for a required argument, including one whose definition
   * omitted `required`.
   */
  public get required(): boolean {
    return this.#definition.required
  }

  /**
   * Builds the JSON Schema a model receives for this argument.
   *
   * @returns A frozen schema; an enum argument becomes a string limited to
   * its values.
   */
  public toAgentFormat(): JsonSchemaProperty {
    return buildToolArgumentFormat(this.#definition)
  }
}
