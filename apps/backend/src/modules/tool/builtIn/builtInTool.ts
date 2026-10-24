import type {
  ListedBackendToolUnavailableReason,
  ChatToolCall
} from "@lys/protocol"
import type { ConversationSource, ToolDefinition } from "@lys/share"

/** Argument values of one call, by argument name, after the type check. */
export type BuiltInToolCallArguments = ChatToolCall["arguments"]

/** One web page or search result a tool shows the model, before numbering. */
export type WebSourceCandidate = Readonly<{
  /**
   * Normalized `http` or `https` address the search returned, or the one
   * Lys was asked to read; where a page's redirects led is not known.
   */
  url: string
  /**
   * Title shown to the model as it reads it: flattened onto one line,
   * without the characters a person cannot see, and trimmed; the URL's host
   * when the result or page gave no title a person can see. Never empty.
   */
  title: string
}>

/**
 * Numbers web sources for the conversation the call belongs to.
 *
 * @param candidates - Sources the result is about to show, in its order.
 * @returns Each candidate numbered, in the same order: a URL the conversation
 * stored, or one numbered earlier in the turn, keeps its number and title;
 * a new URL gets the next number. A number given to a call whose result is
 * never stored is not kept, so a later turn can give it to another URL.
 * Bounded synchronous work; it never throws.
 */
export type AddWebSources = (
  candidates: readonly WebSourceCandidate[]
) => readonly ConversationSource[]

/** What one run of a built-in tool borrows from its turn. */
export type BuiltInToolRunContext = Readonly<{
  /** Stops the run; borrowed for the call. */
  abortSignal: AbortSignal
  /** Numbers the web sources the result shows; borrowed for the call. */
  addWebSources: AddWebSources
}>

/** Text one run of a built-in tool produced for the model. */
export type BuiltInToolResult =
  | Readonly<{
      /** The tool did its work. */
      status: "succeeded"
      /** Output the model reads. */
      content: string
      /**
       * Numbered sources the output shows, in its order, as
       * {@link AddWebSources} returned them; empty when it shows none.
       */
      sources: readonly ConversationSource[]
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
 * @param context - The call's cancellation and source numbering, borrowed
 * for the call.
 * @returns The text the model reads and the sources it shows.
 * @throws The abort reason once the context's signal aborts; any other
 * rejection is a defect, not an expected outcome.
 */
export type BuiltInToolCallRun = (
  context: BuiltInToolRunContext
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

/** Outcome of looking up the tool that runs one turn's calls. */
export type TurnToolLookup =
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
      reason: ListedBackendToolUnavailableReason
    }>

/**
 * A built-in tool provider can give the tool that runs one turn's calls, or
 * say why it cannot run now.
 *
 * @remarks Consumed by the tool list, which reports availability, and by the
 * chat route, which looks up every offered backend tool before it stores a
 * turn. Providers are ready when created. A lookup reads what the tool
 * needs at that moment, such as a saved key, so the tool it gives keeps that
 * for the whole turn. Concurrency model: reentrant.
 */
export interface BuiltInToolProvider {
  /**
   * Finds the tool that runs one turn's calls.
   *
   * @returns `ready` with the tool, or `unavailable` with why. It resolves
   * for every expected state, including a missing or unreadable setting.
   * @throws Only on a defect.
   */
  findTurnTool(): Promise<TurnToolLookup>
}

/** One tool the backend runs: its definition and what finds it for a turn. */
export type BuiltInToolEntry = Readonly<{
  /** Definition offered to the model and listed in Settings; its runner is `backend`. */
  definition: ToolDefinition
  /** Finds the tool for each turn and reports whether it can run. */
  provider: BuiltInToolProvider
}>

/** One backend tool found for a turn: its definition and the tool. */
export type TurnBuiltInTool = Readonly<{
  /** Definition offered to the model. */
  definition: ToolDefinition
  /** Tool that parses and runs the turn's calls. */
  tool: BuiltInTool
  /**
   * Whether the tool's calls run without asking the person: true only for a
   * tool that reads what the person gave Lys for this conversation, such as
   * the attachment reader; every other tool's calls pass the approval gate.
   */
  runsWithoutApproval: boolean
}>
