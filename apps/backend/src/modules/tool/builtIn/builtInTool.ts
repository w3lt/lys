import type { BackendToolUnavailableReason, ChatToolCall } from "@lys/protocol"
import type { ToolDefinition } from "@lys/share"

/** Argument values of one call, by argument name, after the type check. */
export type BuiltInToolCallArguments = ChatToolCall["arguments"]

/** Text one run of a built-in tool produced for the model. */
export type BuiltInToolResult =
  | Readonly<{
      /** The tool did its work. */
      status: "succeeded"
      /** Output the model reads. */
      content: string
    }>
  | Readonly<{
      /** The tool could not do its work, for a reason the model can act on. */
      status: "failed"
      /** Non-empty explanation the model reads. */
      content: string
    }>

/**
 * Runs one parsed call.
 *
 * @param abortSignal - Stops the run; borrowed for the call.
 * @returns The text the model reads.
 * @throws The abort reason once `abortSignal` aborts; any other rejection is
 * a defect, not an expected outcome.
 */
export type BuiltInToolCallRun = (
  abortSignal: AbortSignal
) => Promise<BuiltInToolResult>

/** Outcome of parsing one call's arguments. */
export type ParsedBuiltInToolCall =
  | Readonly<{
      /** The call can run. */
      status: "parsed"
      /** Runs the call; each invocation is an independent run. */
      runToolCall: BuiltInToolCallRun
    }>
  | Readonly<{
      /** The arguments cannot run, for a reason found without running. */
      status: "invalid"
      /** Non-empty explanation the model reads. */
      message: string
    }>

/**
 * A built-in tool can turn the arguments of a call into a run, so the agent
 * loop can run a tool the backend owns without depending on how it works.
 *
 * @remarks Consumed by the agent loop, which parses a call before the person
 * is asked about it and runs it only after the call is allowed. Providers
 * are ready when created and own no resource. Parsing is synchronous and
 * free of side effects; a run may reach an external system. Concurrency
 * model: implementations are reentrant, and parsed calls run independently.
 */
export interface BuiltInTool {
  /**
   * Parses the arguments of one call.
   *
   * @param callArguments - Argument values that matched the tool's
   * definition in type; their meaning is not checked yet.
   * @returns `parsed` with the call's run, or `invalid` with what the model
   * reads when the arguments can never run, such as a URL Lys may not
   * request. It never throws for bad arguments and has no side effects.
   */
  parseToolCall(callArguments: BuiltInToolCallArguments): ParsedBuiltInToolCall
}

/** Outcome of preparing a built-in tool for one turn. */
export type BuiltInToolPreparation =
  | Readonly<{
      /** The tool can run the turn's calls. */
      status: "ready"
      /** Tool that parses and runs the turn's calls. */
      tool: BuiltInTool
    }>
  | Readonly<{
      /** The tool cannot run now. */
      status: "unavailable"
      /** Why. */
      reason: BackendToolUnavailableReason
    }>

/**
 * A built-in tool provider can give the tool that runs one turn's calls, or
 * say why it cannot run now.
 *
 * @remarks Consumed by the tool list, which reports availability, and by the
 * chat route, which prepares every offered backend tool before it stores a
 * turn. Providers are ready when created. A preparation reads what the tool
 * needs at that moment, such as a saved key, so the tool it gives keeps that
 * for the whole turn. Concurrency model: reentrant.
 */
export interface BuiltInToolProvider {
  /**
   * Prepares the tool for one turn.
   *
   * @returns `ready` with the tool, or `unavailable` with why. It resolves
   * for every expected state, including a missing or unreadable setting.
   * @throws Only on a defect.
   */
  prepareTool(): Promise<BuiltInToolPreparation>
}

/** One tool the backend runs: its definition and what prepares it. */
export type BuiltInToolEntry = Readonly<{
  /** Definition offered to the model and listed in Settings; its runner is `backend`. */
  definition: ToolDefinition
  /** Prepares the tool for each turn and reports whether it can run. */
  provider: BuiltInToolProvider
}>

/** One backend tool prepared for a turn: its definition and the tool. */
export type TurnBuiltInTool = Readonly<{
  /** Definition offered to the model. */
  definition: ToolDefinition
  /** Tool that parses and runs the turn's calls. */
  tool: BuiltInTool
}>
