import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  ParsedBuiltInToolCall
} from "../../../src/modules/tool/builtIn/builtInTool"

/**
 * Work one run of a {@link ScriptedBuiltInTool} does.
 *
 * @param word - Word the call asked about.
 * @param abortSignal - The run's cancellation.
 * @returns What the model reads.
 * @throws Whatever the script throws, such as the abort reason.
 */
export type BuiltInToolRunScript = (
  word: string,
  abortSignal: AbortSignal
) => Promise<BuiltInToolResult>

/** Definition of the scripted look-up tool the backend runs. */
export const LOOK_UP_WORD_TOOL: ToolDefinition = toolDefinitionSchema.parse({
  name: "look_up_word",
  description: "Look up one word.",
  group: "network",
  access: "network",
  runner: "backend",
  arguments: [{ type: "string", name: "word", description: "Word to look up." }]
})

/** Function tool a model is offered for {@link LOOK_UP_WORD_TOOL}. */
export const LOOK_UP_WORD_FORMAT = Object.freeze({
  type: "function",
  function: {
    name: "look_up_word",
    description: "Look up one word.",
    parameters: {
      type: "object",
      properties: {
        word: { type: "string", description: "Word to look up." }
      },
      required: ["word"],
      additionalProperties: false
    }
  }
})

/**
 * Run script that answers at once with the word it looked up.
 *
 * @param word - Word the call asked about.
 * @returns A succeeded result naming the word.
 */
export async function answerWithWordDefinition(
  word: string
): Promise<BuiltInToolResult> {
  return { status: "succeeded", content: `${word}: a definition` }
}

/**
 * Owns a run script to stand in for a backend tool in loop tests, recording
 * every run it starts.
 *
 * @remarks Implements {@link BuiltInTool}. The word `unknown` can never run.
 * A run first rejects with the abort reason when its signal already
 * aborted, then follows the script. Concurrency model: single-owner, in one
 * test.
 */
export class ScriptedBuiltInTool implements BuiltInTool {
  /** Work every run does. */
  readonly #runScript: BuiltInToolRunScript
  /** Words of the runs that started, in start order. */
  readonly #startedWords: string[] = []

  /**
   * Creates the tool.
   *
   * @param runScript - Work every run does; answers at once by default.
   */
  public constructor(
    runScript: BuiltInToolRunScript = answerWithWordDefinition
  ) {
    this.#runScript = runScript
  }

  /**
   * Words of the runs that started, in start order.
   *
   * @returns A frozen copy.
   */
  public get startedWords(): readonly string[] {
    return Object.freeze([...this.#startedWords])
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for word look-ups.
   *
   * @param callArguments - The interface-defined argument values: `word`.
   * @returns The interface-defined outcome; `invalid` for the word `unknown`
   * and for a word that is not text.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    const { word } = callArguments
    if (typeof word !== "string" || word === "unknown") {
      return { status: "invalid", message: `Cannot look up ${String(word)}.` }
    }
    return {
      status: "parsed",
      runToolCall: (abortSignal) => this.#runWordLookUp(word, abortSignal)
    }
  }

  /**
   * Runs one look-up.
   *
   * @param word - Word to look up.
   * @param abortSignal - The run's cancellation.
   * @returns The script's result.
   * @throws The abort reason when already stopped, or the script's failure.
   */
  async #runWordLookUp(
    word: string,
    abortSignal: AbortSignal
  ): Promise<BuiltInToolResult> {
    abortSignal.throwIfAborted()
    this.#startedWords.push(word)
    return this.#runScript(word, abortSignal)
  }
}
