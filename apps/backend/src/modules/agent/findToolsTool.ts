import type { MessageGenerationOptions } from "@lys/protocol"
import {
  FIND_TOOLS_TOOL_NAME,
  toolDefinitionSchema,
  type ToolDefinition
} from "@lys/share"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  BuiltInToolRunContext,
  ParsedBuiltInToolCall
} from "../tool/builtIn/builtInTool"
import type { ToolCallPolicy } from "../toolApproval/toolCallPolicy"

/** Inclusive maximum length of a trimmed task, in UTF-16 code units. */
const MAXIMUM_TOOL_TASK_LENGTH = 500

/**
 * Receives why a tool search ended without finding: a refusal, such as a
 * round that did not fit the model's context window, a failure, or a
 * cancellation the model reported although the asking reply was not
 * stopped.
 */
export type ReportToolSearchFailure = (failure: unknown) => void

/** One search for the tools that fit a task, as an asking reply runs it. */
export type ToolSearch = Readonly<{
  /** What the asking agent needs a tool for; trimmed, 1 to 500 characters. */
  task: string
  /**
   * Definitions of the asking turn's client, built-in, and MCP tools, each
   * name once, in offer order; at least one.
   */
  tools: readonly ToolDefinition[]
  /** UUIDv7 of the asking reply's conversation. */
  conversationId: string
  /** Model the asking reply uses. */
  model: string
  /** Sampling and reply length controls of the asking reply. */
  generationOptions: MessageGenerationOptions
  /** Cancellation of the asking reply, aborted by Stop or shutdown. */
  abortSignal: AbortSignal
  /**
   * Receives why the search ended without finding, once; borrowed until
   * the returned promise settles.
   */
  reportFailure: ReportToolSearchFailure
  /**
   * The asking turn's tool call policy; a search answered by a reply of its
   * own, such as Armitage's, decides that reply's tool calls by it.
   */
  toolCallPolicy: ToolCallPolicy
}>

/** Outcome of one search for tools. */
export type ToolSearchOutcome =
  | Readonly<{
      /** The search ran to its end. */
      status: "found"
      /**
       * Names of the tools that fit the task, in the order found, each one
       * of the search's tools, once; at most 5, and empty when none fits.
       */
      toolNames: readonly string[]
    }>
  | Readonly<{
      /** The search could not run or did not finish; nothing was found. */
      status: "failed"
    }>

/**
 * A tool keeper can tell an asking agent which of its turn's tools fit a
 * task, so the agent is offered only those tools.
 *
 * @remarks Consumed by `find_tools`, which a routed reply offers its model.
 * Discovery is not authorization: the keeper only names tools, and every
 * call of a named tool still passes the asking reply's argument check, tool
 * call policy, and approval gate. The provider reads only the definitions
 * the search holds, runs no tool of the asking turn, and keeps nothing of a
 * search after it settles. Ready when created; owns no resource of the caller. Concurrency
 * model: asynchronous on the backend's event loop; searches may overlap and
 * run independently, as many at once as the provider allows, the others
 * failing or waiting their turn.
 */
export interface ToolKeeper {
  /**
   * Finds the tools that fit a task.
   *
   * @param search - The task, the asking turn's tools, the model and its
   * controls, the asking reply's cancellation, and its tool call policy;
   * borrowed until the returned promise settles.
   * @returns `found` with the fitting tools' names, each one of
   * `search.tools`, frozen; `failed` when the search could not run, was
   * refused, failed, or was cancelled by the model, after reporting why to
   * `search.reportFailure`.
   * @throws The signal's abort reason once `search.abortSignal` aborts,
   * whatever the search found by then.
   */
  findTools(search: ToolSearch): Promise<ToolSearchOutcome>
}

/** What `find_tools` of one reply asks the keeper with, besides the task. */
export type FindToolsContext = Readonly<{
  /** Keeper of the turn's tools; lent for the reply. */
  keeper: ToolKeeper
  /**
   * Definitions of the asking turn's client, built-in, and MCP tools, each
   * name once, in offer order; at least one.
   */
  tools: readonly ToolDefinition[]
  /** UUIDv7 of the reply's conversation. */
  conversationId: string
  /** Model the reply uses. */
  model: string
  /** Sampling and reply length controls of the reply. */
  generationOptions: MessageGenerationOptions
  /** Receives why a search ended without finding; lent for the reply. */
  reportFailure: ReportToolSearchFailure
  /** What the fixed tool call rules know about this machine. */
  toolCallPolicy: ToolCallPolicy
}>

/** Copy shown for a task that is blank or too long. */
const INVALID_TASK_MESSAGE = `The task must be 1 to ${MAXIMUM_TOOL_TASK_LENGTH} characters long after trimming.`

/** Copy shown when the keeper found no tool. */
const NO_TOOL_FOUND_MESSAGE =
  "Armitage found no tool for this task. Describe the task in other words, or tell the person you have no tool for it."

/** Result shown when the keeper could not search. */
const FAILED_SEARCH_RESULT: BuiltInToolResult = Object.freeze({
  status: "failed",
  content:
    "Armitage could not search the tools now. Try again, or go on without a tool."
})

/** Sources a `find_tools` result shows: none. */
const NO_SOURCES = Object.freeze([])

/** The task argument of `find_tools`. */
const TASK_ARGUMENT = Object.freeze({
  type: "string",
  name: "task",
  description: `What you need a tool for, such as "read a web page"; 1 to ${MAXIMUM_TOOL_TASK_LENGTH} characters.`
})

/** Arguments of `find_tools`. */
const FIND_TOOLS_ARGUMENTS = Object.freeze([TASK_ARGUMENT])

/** Definition of the tool that asks the tool keeper for tools. */
export const FIND_TOOLS_DEFINITION: ToolDefinition = toolDefinitionSchema.parse(
  {
    name: FIND_TOOLS_TOOL_NAME,
    description:
      "Ask Armitage, the tool keeper, for the tools that fit a task. Armitage searches your tools and offers you the ones that fit from your next step. Describe the task, not a tool name.",
    group: "agents",
    access: "reads",
    runner: "backend",
    arguments: FIND_TOOLS_ARGUMENTS
  }
)

/**
 * Formats the note a routed turn's system prompt ends with.
 *
 * @param toolCount - Number of the turn's client, built-in, and MCP tools;
 * a positive integer.
 * @returns The note telling the model how many tools Armitage keeps for it
 * and to call `find_tools` before it uses one.
 */
export function formatToolRoutingNote(toolCount: number): string {
  const tools = toolCount === 1 ? "1 tool" : `${toolCount} tools`
  return `You have ${tools} that Armitage, the tool keeper, keeps for you. Before you use one, call ${FIND_TOOLS_TOOL_NAME} with what you need a tool for, such as "read a web page"; the tools Armitage finds are offered to you from your next step.`
}

/**
 * Builds a result the model reads as a success.
 *
 * @param content - Output the model reads.
 * @returns The frozen result, showing no sources.
 */
function buildSucceededResult(content: string): BuiltInToolResult {
  return Object.freeze({ status: "succeeded", content, sources: NO_SOURCES })
}

/**
 * Asks the tool keeper for the tools that fit a task, for one routed reply,
 * and keeps the tools it found for the reply's next rounds.
 *
 * @remarks Invariant: every kept name is one of the turn's tools, kept
 * once, in the order found; the list only grows. A failed or stopped search
 * keeps nothing. It never runs a found tool and never decides whether one
 * may run: the reply offers the found tools, and each call of one passes
 * the reply's checks and gate. Created per reply and dropped with it; owns
 * no resource, and the keeper is lent for the reply. Concurrency model:
 * reentrant on the backend's event loop; parsed calls run independently,
 * each keeping its names in one synchronous step when its search settles.
 */
export default class FindToolsTool implements BuiltInTool {
  /** The keeper, the turn's tools, and the reply's model and controls. */
  readonly #context: FindToolsContext

  /** Names of the tools found so far, in the order found. */
  readonly #foundNames = new Set<string>()

  /**
   * Keeps the reply's context without asking the keeper anything.
   *
   * @param context - The keeper, the turn's tools, and the reply's
   * conversation, model, and controls, lent for the reply.
   */
  public constructor(context: FindToolsContext) {
    this.#context = context
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for `find_tools`.
   *
   * @param callArguments - The interface-defined argument values: `task`,
   * a string.
   * @returns `invalid` for a task that is blank or longer than
   * {@link MAXIMUM_TOOL_TASK_LENGTH} after trimming; otherwise `parsed`,
   * whose run asks the keeper once.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    const value = callArguments["task"]
    const task = typeof value === "string" ? value.trim() : undefined
    if (
      task === undefined ||
      task.length === 0 ||
      task.length > MAXIMUM_TOOL_TASK_LENGTH
    )
      return Object.freeze({ status: "invalid", message: INVALID_TASK_MESSAGE })
    return Object.freeze({
      status: "parsed",
      runToolCall: async (context) => await this.#findTools(task, context)
    })
  }

  /**
   * Lists the tools found so far.
   *
   * @returns A frozen list of their names, in the order found; later
   * searches leave it as it was.
   */
  public listFoundToolNames(): readonly string[] {
    return Object.freeze([...this.#foundNames])
  }

  /**
   * Runs one search and keeps what it found.
   *
   * @param task - Trimmed task of the call.
   * @param context - The run's cancellation.
   * @returns The tools found, named for the model, or that none was found;
   * a failure when the keeper could not search.
   * @throws The abort reason when the run's signal aborted before or during
   * the search; nothing is kept then.
   */
  async #findTools(
    task: string,
    context: BuiltInToolRunContext
  ): Promise<BuiltInToolResult> {
    const { abortSignal } = context
    abortSignal.throwIfAborted()
    const { keeper, ...search } = this.#context
    const outcome = await keeper.findTools({ ...search, task, abortSignal })
    abortSignal.throwIfAborted()
    if (outcome.status === "failed") return FAILED_SEARCH_RESULT
    const toolNames = outcome.toolNames.filter((name) =>
      search.tools.some((tool) => tool.name === name)
    )
    if (toolNames.length === 0)
      return buildSucceededResult(NO_TOOL_FOUND_MESSAGE)
    for (const name of toolNames) this.#foundNames.add(name)
    return buildSucceededResult(
      `Armitage found these tools for the task, and you can call them from your next step: ${toolNames.join(", ")}.`
    )
  }
}
