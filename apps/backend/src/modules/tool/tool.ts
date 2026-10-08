import {
  buildToolFunctionFormat,
  toolDefinitionSchema,
  type OpenAIFunctionTool,
  type ToolDefinition,
  type ToolDefinitionCandidate
} from "@lys/share"

/**
 * Owns one validated tool definition to provide the function tool a model is
 * offered.
 *
 * @remarks The definition is validated when the tool is created and never
 * changes afterwards. Its `group` and `access` describe the tool to the
 * person using Lys and never reach the model. Concurrency model: reentrant;
 * the tool owns no mutable state and retains no collaborator.
 */
export default class AgentTool {
  /** Validated, frozen definition of the tool. */
  readonly #definition: ToolDefinition

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
}
