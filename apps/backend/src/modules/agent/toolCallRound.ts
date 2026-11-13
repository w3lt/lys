import {
  TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES,
  type ChatToolApprovalAnswer,
  type ChatToolCall,
  type ChatToolResult
} from "@lys/protocol"
import {
  FIND_TOOLS_TOOL_NAME,
  type ConversationSource,
  type OpenAIFunctionTool,
  type ToolDefinition
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type { TurnMcpTool } from "../mcp/mcpServerRegistry"
import type {
  BuiltInTool,
  BuiltInToolCallRun,
  TurnBuiltInTool
} from "../tool/builtIn/builtInTool"
import { formatNetworkToolResult } from "../tool/networkToolResult"
import AgentTool from "../tool/tool"
import type { ToolCallDecisionRecord } from "../toolApproval/toolCallDecisionRecord"
import type ToolCallGate from "../toolApproval/toolCallGate"
import type { ToolApprovalPromptOutcome } from "../toolApproval/toolCallGate"
import {
  decideToolCall,
  formatToolCallDenial,
  readToolCallRules,
  type ToolCallDecision,
  type ToolCallPolicy,
  type ToolCallRequest,
  type ToolCallRules
} from "../toolApproval/toolCallPolicy"
import type ReplyPartSequence from "./replyPartSequence"
import type {
  ContextToolCall,
  ModelToolCall,
  ReplyContextMessage
} from "./replyModel"
import type SourceCatalog from "./sourceCatalog"
import {
  findUnofferedToolCallMessage,
  hasUnofferedToolNote,
  type UnofferedTools
} from "./unofferedTools"

/** One tool offered for a turn, with the side that runs it. */
type OfferedTool =
  | Readonly<{
      /** The client runs the tool and answers each call with its result. */
      runner: "client"
      /** Checks the argument types of each call. */
      agentTool: AgentTool
    }>
  | Readonly<{
      /** The backend runs the tool once each call is allowed. */
      runner: "backend"
      /** Checks the argument types of each call. */
      agentTool: AgentTool
      /** Parses and runs each allowed call. */
      builtInTool: BuiltInTool
      /** Whether each call runs at once, without the person being asked. */
      runsWithoutApproval: boolean
    }>
  | Readonly<{
      /** The backend runs each allowed call on the tool's MCP server. */
      runner: "mcp"
      /** Checks the shape of each call's arguments. */
      agentTool: AgentTool
      /** Runs each allowed call on its server. */
      mcpTool: TurnMcpTool
    }>

/** One backend tool offered for a turn. */
type OfferedBuiltInTool = Extract<OfferedTool, { runner: "backend" }>

/** One MCP tool offered for a turn. */
type OfferedMcpTool = Extract<OfferedTool, { runner: "mcp" }>

/** Tools offered for one turn, by the name the model calls them by, in offer order. */
export type AgentToolset = ReadonlyMap<string, OfferedTool>

/** Tools one turn offers, by kind, each name once across all of them. */
export type AgentToolsetInput = Readonly<{
  /**
   * Backend tools the reply offers its model in every round, whether or not
   * it routes the others through `find_tools`, in offer order; empty when
   * none.
   */
  directTools: readonly TurnBuiltInTool[]
  /** Validated definitions of the client tools, in offer order. */
  clientTools: readonly ToolDefinition[]
  /** Built-in tools found for the turn, in offer order. */
  builtInTools: readonly TurnBuiltInTool[]
  /** MCP tools found for the turn, in offer order. */
  mcpTools: readonly TurnMcpTool[]
  /**
   * The agent's state tools for the turn, in offer order; empty when the
   * turn offers none.
   */
  agentStateTools: readonly TurnBuiltInTool[]
}>

/** A round that ended with tool calls: the text it wrote and the calls it made. */
export type ToolCallRound = Readonly<{
  /** Zero-based index of the round in its reply. */
  round: number
  /** Text the round wrote before its calls; empty when it wrote none. */
  text: string
  /** Calls in the model's order; at least one. */
  toolCalls: readonly ModelToolCall[]
}>

/**
 * Sends one allowed call of a client tool to the client to run and waits for
 * its result; resolves with undefined when the reply was stopped while the
 * call waited.
 */
export type SendClientToolCall = (
  toolCall: ChatToolCall
) => Promise<ChatToolResult | undefined>

/**
 * Creates the approval gate of one round from the choices saved when the
 * round's calls arrive; rejects only when the saved choices cannot be read
 * for a reason other than an unreadable file. Called only for a round with
 * a call to gate.
 */
export type CreateToolCallGate = () => Promise<ToolCallGate>

/** What answering one round's calls needs from the turn. */
export type ToolCallRoundContext = Readonly<{
  /**
   * Tools the round offered; a call of any other tool, a tool of the turn
   * the round did not offer included, is answered as not run.
   */
  tools: AgentToolset
  /**
   * What the request names about the tools the turn does not offer; a call
   * of one is answered as not run, and so is a call of any tool not offered
   * while tool calls are off.
   */
  unofferedTools: UnofferedTools
  /** Sends one allowed call of a client tool to run. */
  sendClientToolCall: SendClientToolCall
  /**
   * What the tool call rules know about this machine, and the reader of the
   * folders the person lets tools use; every checked call of an offered tool
   * is decided by the rules, with the folders read once for the round, before
   * it starts, and a call the person allowed is decided again, with the
   * folders read again, before it runs.
   */
  toolCallPolicy: ToolCallPolicy
  /**
   * Creates the approval gate every checked call the policy does not deny
   * passes, except an allowed call of a backend tool that runs without
   * approval; called once for a round that has a call of a tool that may need
   * it, and not at all otherwise.
   */
  createToolCallGate: CreateToolCallGate
  /** Stops the reply; an allowed backend or MCP tool runs under it. */
  abortSignal: AbortSignal
  /** Stores and sends each call and its changes as parts of the reply. */
  replyParts: ReplyPartSequence
  /** Numbers the web sources a backend tool's result shows. */
  sourceCatalog: SourceCatalog
}>

/** What handling one call of a round needs. */
type ToolCallHandling = Readonly<{
  /** Tools the round offered. */
  tools: AgentToolset
  /** What the request names about the tools the turn does not offer. */
  unofferedTools: UnofferedTools
  /**
   * What the rules know about this machine; read again for the re-check of a
   * call the person allowed.
   */
  toolCallPolicy: ToolCallPolicy
  /** What the rules decide the round's calls by, read for the round. */
  toolCallRules: ToolCallRules
  /**
   * Approval gate of the round; undefined when no call of the round passes
   * one, because every call names a tool that runs without approval or no
   * offered tool.
   */
  gate: ToolCallGate | undefined
  /** Zero-based index of the round. */
  round: number
  /** Sends one allowed call of a client tool to run. */
  sendClientToolCall: SendClientToolCall
  /** Stops the reply; an allowed backend tool runs under it. */
  abortSignal: AbortSignal
  /** Stores and sends each call and its changes as parts of the reply. */
  replyParts: ReplyPartSequence
  /** Numbers the web sources a backend tool's result shows. */
  sourceCatalog: SourceCatalog
}>

/** What storing a call needs: the round and the parts. */
type ToolCallPartHandling = Pick<ToolCallHandling, "round" | "replyParts">

/**
 * What starting a checked call needs: the policy and the round's rules, the
 * reply's cancellation, the gate, the round, and the parts.
 */
type ToolCallStartHandling = Pick<
  ToolCallHandling,
  | "toolCallPolicy"
  | "toolCallRules"
  | "abortSignal"
  | "gate"
  | "round"
  | "replyParts"
>

/** What starting a checked call through the round's gate needs. */
type GatedToolCallStartHandling = Pick<
  ToolCallHandling,
  "toolCallPolicy" | "abortSignal" | "gate" | "round" | "replyParts"
>

/** What storing the person's answer to a call's prompt needs. */
type ToolCallAnswerHandling = Pick<
  ToolCallHandling,
  "toolCallPolicy" | "abortSignal" | "replyParts"
>

/** What handling a checked call of a client tool needs. */
type ClientToolCallHandling = ToolCallStartHandling &
  Pick<ToolCallHandling, "sendClientToolCall">

/** What handling a checked call of a backend tool needs. */
type BuiltInToolCallHandling = ToolCallStartHandling &
  Pick<ToolCallHandling, "abortSignal" | "sourceCatalog">

/** What handling a checked call of an MCP tool needs. */
type McpToolCallHandling = ToolCallStartHandling &
  Pick<ToolCallHandling, "abortSignal">

/** What running an allowed backend call needs: cancellation and numbering. */
type BuiltInToolRunHandling = Pick<
  ToolCallHandling,
  "abortSignal" | "sourceCatalog"
>

/** One call being handled: as the model wrote it, and the tool it names. */
type HandledToolCall = Readonly<{
  /** The call with its identifier and the model's argument text. */
  call: ContextToolCall
  /** Offered tool the call names, or undefined when it names none. */
  tool: OfferedTool | undefined
}>

/** One checked call of an offered tool. */
type CheckedToolCall = Readonly<{
  /** The call with its identifier and the model's argument text. */
  call: ContextToolCall
  /** Offered tool the call names. */
  tool: OfferedTool
  /** The call with its checked arguments. */
  checkedCall: ChatToolCall
}>

/** How a call that ran ended, before it is cleaned and stored. */
type ToolCallRunOutcome =
  | Readonly<{
      /** The tool returned its output. */
      status: "succeeded"
      /** Output the model reads. */
      content: string
      /** Numbered sources the output shows; empty when it shows none. */
      sources: readonly ConversationSource[]
    }>
  | Readonly<{
      /** The tool, or the client running it, reported a failure. */
      status: "failed"
      /** Explanation the model reads. */
      content: string
    }>

/** What deciding and approving one call led to. */
type ToolCallApproval =
  | Readonly<{
      /** The call may run; it is stored as running. */
      status: "allowed"
    }>
  | Readonly<{
      /**
       * The policy denied the call, which is stored as failed; it never
       * runs. A call denied before the gate was never asked about; one
       * denied again after the person allowed it was.
       */
      status: "denied"
      /** Message carrying the denial the model reads. */
      message: ToolResultMessage
    }>
  | Readonly<{
      /** The person rejected the call, which is stored as rejected. */
      status: "rejected"
      /** Message carrying the rejection the model reads. */
      message: ToolResultMessage
    }>
  | Readonly<{
      /**
       * Nobody answered the call's prompt within its time limit; the call is
       * stored as failed and never runs.
       */
      status: "expired"
      /** Message carrying the expiry the model reads. */
      message: ToolResultMessage
    }>
  | Readonly<{
      /** The reply ended while the call waited, or refused to store it. */
      status: "ended"
    }>

/**
 * What starting one call led to: an approval known at once, or the wait for
 * the person's answer.
 */
type StartedToolCall =
  | ToolCallApproval
  | Readonly<{
      /** The person was asked; the call is stored as awaiting approval. */
      status: "waiting"
      /** Settles with the approval once the person answered. */
      approval: Promise<ToolCallApproval>
    }>

/** Context message that carries one tool call's result. */
type ToolResultMessage = Extract<ReplyContextMessage, { role: "tool" }>

/** A policy answer that lets a call go on to the approval gate. */
type GatedToolCallDecision = Exclude<ToolCallDecision, { effect: "deny" }>

/** The person's answer when they did not allow a call. */
type RejectedToolApprovalAnswer = Extract<
  ChatToolApprovalAnswer,
  { status: "rejected" }
>

/** Decision of a call Lys's own checks failed before the policy was asked. */
const UNCHECKED_TOOL_CALL_DECISION: ToolCallDecisionRecord = Object.freeze({
  policyDecision: undefined,
  approvalMode: undefined
})

/**
 * Decision of an allowed call of a tool that runs without approval, which
 * never reaches the gate.
 */
const UNPROMPTED_TOOL_CALL_DECISION: ToolCallDecisionRecord = Object.freeze({
  policyDecision: Object.freeze({ effect: "allow" }),
  approvalMode: undefined
})

/** Sources of a result that shows none. */
const NO_SOURCES: readonly ConversationSource[] = Object.freeze([])

/** Approval outcome after the reply ended. */
const ENDED_TOOL_CALL_APPROVAL: ToolCallApproval = Object.freeze({
  status: "ended"
})

/** Approval outcome of a call that may run. */
const ALLOWED_TOOL_CALL_APPROVAL: ToolCallApproval = Object.freeze({
  status: "allowed"
})

/**
 * Text the model reads for a call whose approval prompt reached its time
 * limit without an answer.
 */
const EXPIRED_TOOL_APPROVAL_RESULT = `This call did not run: nobody answered its approval prompt within ${TOOL_APPROVAL_PROMPT_TIME_LIMIT_MINUTES} minutes, so the prompt expired. Tell the person what you wanted it for; they can ask you to try again.`

/**
 * Builds the tools of one turn from the offered tools.
 *
 * @param input - The turn's direct, client, built-in, MCP, and agent state
 * tools.
 * @returns The tools by name: direct tools, then client tools, then
 * built-in tools, then MCP tools, then the agent's state tools, each in
 * offer order.
 * @throws If two tools share a name; the chat request contract, which
 * reserves the backend's own tool names, and the `mcp__` names of MCP tools
 * prevent that.
 */
export function buildAgentToolset(input: AgentToolsetInput): AgentToolset {
  const tools = new Map<string, OfferedTool>()
  addBuiltInTools(tools, input.directTools)
  for (const definition of input.clientTools)
    addOfferedTool(tools, new AgentTool(definition), (agentTool) => ({
      runner: "client",
      agentTool
    }))
  addBuiltInTools(tools, input.builtInTools)
  for (const mcpTool of input.mcpTools)
    addOfferedTool(tools, new AgentTool(mcpTool.definition), (agentTool) => ({
      runner: "mcp",
      agentTool,
      mcpTool
    }))
  addBuiltInTools(tools, input.agentStateTools)
  return tools
}

/**
 * Adds built-in tools to a turn's toolset, each under its name.
 *
 * @param tools - Toolset being built.
 * @param entries - Built-in tools found for the turn, in offer order.
 * @throws If the toolset already has a tool of one of their names.
 */
function addBuiltInTools(
  tools: Map<string, OfferedTool>,
  entries: readonly TurnBuiltInTool[]
): void {
  for (const entry of entries)
    addOfferedTool(tools, new AgentTool(entry.definition), (agentTool) => ({
      runner: "backend",
      agentTool,
      builtInTool: entry.tool,
      runsWithoutApproval: entry.runsWithoutApproval
    }))
}

/**
 * Adds one tool to a turn's toolset under its name.
 *
 * @param tools - Toolset being built.
 * @param agentTool - Checker of the tool's calls.
 * @param buildTool - Builds the offered tool around the checker.
 * @throws If the toolset already has a tool of that name.
 */
function addOfferedTool(
  tools: Map<string, OfferedTool>,
  agentTool: AgentTool,
  buildTool: (agentTool: AgentTool) => OfferedTool
): void {
  if (tools.has(agentTool.name))
    throw new Error(`Tool ${agentTool.name} is offered twice`)
  tools.set(agentTool.name, Object.freeze(buildTool(agentTool)))
}

/**
 * Builds the function tools a model would be offered for tool definitions.
 *
 * @param definitions - Offered tool definitions in offer order: client tools
 * first, then backend tools, as {@link buildAgentToolset} orders them.
 * @returns A frozen list in the same order and format as a reply offers a
 * turn with these tools in every round; empty for no definition.
 * @throws A Zod error when a definition does not match `toolDefinitionSchema`.
 */
export function buildDefinedToolOffer(
  definitions: readonly ToolDefinition[]
): readonly OpenAIFunctionTool[] {
  return Object.freeze(
    definitions.map((definition) =>
      new AgentTool(definition).buildAgentFormat()
    )
  )
}

/**
 * Has every call of one round answered, storing each as a part of the reply,
 * and builds the messages that add the round to the context.
 *
 * @param round - The round's index, text, and calls in the model's order.
 * @param context - Tools, the client call sender, the tool call policy, the
 * gate factory, the reply's cancellation, its part sequence, and the turn's
 * source catalog.
 * @returns The assistant message with the round's text and calls, then one
 * result message per call in the model's order; or undefined when the reply
 * was stopped while the gate was created, a call waited, or a backend tool
 * ran, or the reply refused to store a call because it ended.
 * @throws If the turn offered no tools and tells the model nothing about the
 * tools it does not offer: the model called a tool it was not offered, which
 * ends the reply as failed, as before tools existed. Also throws when the
 * gate cannot be created, the approved folders cannot be read, or a backend
 * tool's run fails for a reason other than Stop.
 * @remarks Each call gets a new UUIDv7, which is its part's identity. Calls
 * of tools the turn does not offer, named or not, and calls whose arguments
 * do not match are stored as failed with the message the model reads; nobody
 * is asked about them, and none of them runs. Every other call is decided by
 * the tool call rules first, with the approved folders read once for the
 * round: a denied call is stored as failed with
 * the denial the model reads, never runs, and nobody is asked about it,
 * whatever the person saved for the tool. A call the policy requires approval
 * of passes the round's gate, which asks the person even when they saved its
 * tool as Just run. Of the allowed calls, a call of a backend tool that runs
 * without approval is stored as running at once. Every other call passes the
 * round's gate, created once for a round that has a call of a tool that may
 * need it, so the saved choices are read at most once per round and not at
 * all for a round whose calls all run without approval or name no offered
 * tool. The calls' parts, the gate's prompts, each after the part of the call
 * it asks about, and the run requests of calls allowed at once are sent
 * before the first wait, in the model's order, because each call's handling
 * runs synchronously up to its first send. Nothing runs before its call is
 * allowed; a call the person allowed is decided again, with the folders read
 * again, and one the rules now deny is stored as failed and never runs.
 * Every result the model reads is stored with its call first; the result of
 * a tool that does more than read this machine, a network or MCP
 * tool, is cleaned of invisible characters before that, whichever side
 * answered and however the call ended.
 */
export async function handleToolCallRound(
  round: ToolCallRound,
  context: ToolCallRoundContext
): Promise<readonly ReplyContextMessage[] | undefined> {
  if (context.tools.size === 0 && !hasUnofferedToolNote(context.unofferedTools))
    throw new Error("The model called a tool although none was offered")
  const toolCalls = Object.freeze(round.toolCalls.map(createContextToolCall))
  const gate = hasGatedToolCall(toolCalls, context.tools)
    ? await context.createToolCallGate()
    : undefined
  const toolCallRules = await readToolCallRules(context.toolCallPolicy)
  if (context.abortSignal.aborted) return undefined
  const handling: ToolCallHandling = Object.freeze({
    tools: context.tools,
    unofferedTools: context.unofferedTools,
    toolCallPolicy: context.toolCallPolicy,
    toolCallRules,
    gate,
    round: round.round,
    sendClientToolCall: context.sendClientToolCall,
    abortSignal: context.abortSignal,
    replyParts: context.replyParts,
    sourceCatalog: context.sourceCatalog
  })
  const toolMessages = await Promise.all(
    toolCalls.map((toolCall) => handleToolCall(toolCall, handling))
  )
  if (!toolMessages.every(isToolResultMessage)) return undefined
  const assistantMessage: ReplyContextMessage = Object.freeze({
    role: "assistant",
    content: round.text,
    toolCalls
  })
  return Object.freeze([assistantMessage, ...toolMessages])
}

/**
 * Answers whether a round has a call that may pass the approval gate.
 *
 * @param toolCalls - The round's calls.
 * @param tools - Tools the round offered.
 * @returns True when a call names an offered tool other than a backend tool
 * that runs without approval; a call of an unknown tool is answered without
 * a gate, and so is a call of a tool that runs without approval. The
 * arguments are not read, so a round whose only such calls are invalid or
 * denied still has a gate, which none of them asks.
 */
function hasGatedToolCall(
  toolCalls: readonly ContextToolCall[],
  tools: AgentToolset
): boolean {
  return toolCalls.some((toolCall) => {
    const tool = tools.get(toolCall.toolName)
    return tool !== undefined && !runsWithoutApproval(tool)
  })
}

/**
 * Answers whether every allowed call of a tool runs without the person
 * being asked.
 *
 * @param tool - Offered tool.
 * @returns True for a backend tool that runs without approval.
 */
function runsWithoutApproval(tool: OfferedTool): boolean {
  return tool.runner === "backend" && tool.runsWithoutApproval
}

/**
 * Creates the context form of one call the model made.
 *
 * @param toolCall - Call as the model wrote it.
 * @returns The call with a new UUIDv7.
 */
function createContextToolCall(toolCall: ModelToolCall): ContextToolCall {
  return Object.freeze({
    id: uuidv7(),
    toolName: toolCall.toolName,
    argumentText: toolCall.argumentText
  })
}

/**
 * Has one call answered and stored: through the tool execution gateway and
 * then the client, the backend tool, or the MCP server when it is a checked
 * call of an offered tool, or here otherwise.
 *
 * @param toolCall - Call with its identifier.
 * @param handling - Tools, the policy, the round's gate and index, the
 * client call sender, the reply's cancellation, its part sequence, and the
 * source catalog.
 * @returns The message carrying the text the model reads as the result, or
 * undefined when the reply was stopped while the call waited or ran, or
 * refused to store the call.
 * @throws When a backend tool's run fails for a reason other than Stop, or
 * an MCP tool's call rejects although the reply was not stopped.
 */
async function handleToolCall(
  toolCall: ContextToolCall,
  handling: ToolCallHandling
): Promise<ToolResultMessage | undefined> {
  const tool = handling.tools.get(toolCall.toolName)
  const handledCall: HandledToolCall = Object.freeze({ call: toolCall, tool })
  if (tool === undefined)
    return createFailedToolCall(
      handledCall,
      formatMissingToolMessage(toolCall, handling),
      UNCHECKED_TOOL_CALL_DECISION,
      handling
    )
  const checkedArguments = tool.agentTool.parseCallArguments(
    toolCall.argumentText
  )
  if (checkedArguments.status === "invalid")
    return createFailedToolCall(
      handledCall,
      checkedArguments.message,
      UNCHECKED_TOOL_CALL_DECISION,
      handling
    )
  const checkedCall: ChatToolCall = Object.freeze({
    id: toolCall.id,
    toolName: toolCall.toolName,
    arguments: checkedArguments.arguments
  })
  const checkedToolCall: CheckedToolCall = Object.freeze({
    call: toolCall,
    tool,
    checkedCall
  })
  switch (tool.runner) {
    case "client":
      return handleClientToolCall(checkedToolCall, handling)
    case "backend":
      return handleBuiltInToolCall(checkedToolCall, tool, handling)
    case "mcp":
      return handleMcpToolCall(checkedToolCall, tool, handling)
  }
}

/**
 * Has one checked call of a client tool allowed, then has the client run it.
 *
 * @param toolCall - Checked call.
 * @param handling - The policy, the round's gate and index, the client call
 * sender, and the reply's part sequence.
 * @returns The message carrying the client's result, the policy's denial,
 * or the person's rejection; or undefined when the reply was stopped while
 * the call waited, or refused to store the call.
 */
async function handleClientToolCall(
  toolCall: CheckedToolCall,
  handling: ClientToolCallHandling
): Promise<ToolResultMessage | undefined> {
  const startedCall = startToolCall(toolCall, handling)
  const approval =
    startedCall.status === "waiting" ? await startedCall.approval : startedCall
  if (approval.status === "ended") return undefined
  if (approval.status !== "allowed") return approval.message
  const result = await handling.sendClientToolCall(toolCall.checkedCall)
  if (result === undefined) return undefined
  const outcome: ToolCallRunOutcome =
    result.status === "succeeded"
      ? { status: "succeeded", content: result.content, sources: NO_SOURCES }
      : { status: "failed", content: result.content }
  return updateFinishedToolCall(toolCall, outcome, handling.replyParts)
}

/**
 * Parses one checked call of a backend tool, has it allowed, and runs it.
 *
 * @param toolCall - Checked call.
 * @param tool - Backend tool the call names.
 * @param handling - The policy, the round's gate and index, the reply's
 * cancellation and part sequence, and the source catalog.
 * @returns The message carrying the run's text, the tool's explanation of
 * arguments it cannot run, the policy's denial, or the person's rejection;
 * or undefined when the reply was stopped while the call waited or ran, or
 * refused to store the call.
 * @throws When the run rejects although the reply was not stopped.
 * @remarks Arguments the tool cannot run are answered before the policy and
 * the gate are asked, so the person never sees a call that cannot succeed.
 * An allowed call of a tool that runs without approval is stored as
 * running at once, and the gate is not asked.
 */
async function handleBuiltInToolCall(
  toolCall: CheckedToolCall,
  tool: OfferedBuiltInTool,
  handling: BuiltInToolCallHandling
): Promise<ToolResultMessage | undefined> {
  const parsedCall = tool.builtInTool.parseToolCall(
    toolCall.checkedCall.arguments
  )
  if (parsedCall.status === "invalid")
    return createFailedToolCall(
      toolCall,
      parsedCall.message,
      UNCHECKED_TOOL_CALL_DECISION,
      handling
    )
  const startedCall = startToolCall(toolCall, handling)
  const approval =
    startedCall.status === "waiting" ? await startedCall.approval : startedCall
  if (approval.status === "ended") return undefined
  if (approval.status !== "allowed") return approval.message
  const outcome = await runBuiltInToolCall(
    toolCall.call.id,
    parsedCall.runToolCall,
    handling
  )
  if (outcome === undefined) return undefined
  return updateFinishedToolCall(toolCall, outcome, handling.replyParts)
}

/**
 * Has one checked call of an MCP tool allowed, then runs it on its server.
 *
 * @param toolCall - Checked call.
 * @param tool - MCP tool the call names.
 * @param handling - The policy, the round's gate and index, the reply's
 * cancellation, and its part sequence.
 * @returns The message carrying the server's result or why the call failed,
 * the policy's denial, or the person's rejection; or undefined when the
 * reply was stopped while the call waited or ran, or refused to store the
 * call.
 * @throws When the call rejects although the reply was not stopped.
 * @remarks Every call the policy does not deny passes the gate, which asks
 * the person unless they saved the tool as Just run and the policy allowed
 * the call; a call of a tool its server marks as destructive is asked about
 * even on Just run. The server checks the arguments against its own schema.
 */
async function handleMcpToolCall(
  toolCall: CheckedToolCall,
  tool: OfferedMcpTool,
  handling: McpToolCallHandling
): Promise<ToolResultMessage | undefined> {
  const startedCall = startToolCall(toolCall, handling)
  const approval =
    startedCall.status === "waiting" ? await startedCall.approval : startedCall
  if (approval.status === "ended") return undefined
  if (approval.status !== "allowed") return approval.message
  let outcome: ToolCallRunOutcome
  try {
    const result = await tool.mcpTool.sendToolCall(
      toolCall.checkedCall.arguments,
      handling.abortSignal
    )
    outcome =
      result.status === "succeeded"
        ? { status: "succeeded", content: result.content, sources: NO_SOURCES }
        : { status: "failed", content: result.content }
  } catch (error) {
    if (handling.abortSignal.aborted) return undefined
    throw error
  }
  return updateFinishedToolCall(toolCall, outcome, handling.replyParts)
}

/**
 * Runs one allowed call of a backend tool under the reply's cancellation.
 *
 * @param toolCallId - UUIDv7 of the stored call.
 * @param runToolCall - The parsed call's run.
 * @param handling - The reply's cancellation and the source catalog.
 * @returns The run's outcome, or undefined when the reply was stopped while
 * it ran.
 * @throws When the run rejects although the reply was not stopped.
 */
async function runBuiltInToolCall(
  toolCallId: string,
  runToolCall: BuiltInToolCallRun,
  handling: BuiltInToolRunHandling
): Promise<ToolCallRunOutcome | undefined> {
  const { sourceCatalog } = handling
  try {
    return await runToolCall({
      toolCallId,
      abortSignal: handling.abortSignal,
      addWebSources: (candidates) => sourceCatalog.addWebSources(candidates)
    })
  } catch (error) {
    if (handling.abortSignal.aborted) return undefined
    throw error
  }
}

/**
 * Stores one checked call in the state chosen for it, with how it was
 * decided.
 *
 * @param toolCall - Checked call.
 * @param status - `running` when it may run at once, `awaiting-approval`
 * when the person is asked.
 * @param decision - The policy's answer and the approval mode applied.
 * @param handling - The round's index and the reply's part sequence.
 * @returns True once stored and sent; false when the reply refused it.
 */
function createStartedToolCall(
  toolCall: CheckedToolCall,
  status: "awaiting-approval" | "running",
  decision: ToolCallDecisionRecord,
  handling: ToolCallPartHandling
): boolean {
  return handling.replyParts.createReplyToolCall({
    kind: "tool-call",
    id: toolCall.call.id,
    round: handling.round,
    toolName: toolCall.call.toolName,
    argumentText: toolCall.call.argumentText,
    decision,
    status
  })
}

/**
 * Starts one checked call of a tool that runs without approval: stores it
 * as running without asking anyone.
 *
 * @param toolCall - Checked call.
 * @param handling - The round's index and the reply's part sequence.
 * @returns `allowed` once the call is stored as running; `ended` when the
 * reply refused to store it.
 */
function startUnpromptedToolCall(
  toolCall: CheckedToolCall,
  handling: ToolCallPartHandling
): ToolCallApproval {
  return createStartedToolCall(
    toolCall,
    "running",
    UNPROMPTED_TOOL_CALL_DECISION,
    handling
  )
    ? ALLOWED_TOOL_CALL_APPROVAL
    : ENDED_TOOL_CALL_APPROVAL
}

/**
 * Starts one checked call through the tool execution gateway: the fixed
 * policy decides it, then the person's approval mode, in one synchronous
 * step.
 *
 * @param toolCall - Checked call.
 * @param handling - The policy, the round's gate and index, and the reply's
 * part sequence.
 * @returns `denied` with the denial the model reads, once the call is
 * stored as failed. For a call the policy requires approval of, as
 * {@link startGatedToolCall} returns when the person is always asked. For an
 * allowed call, as {@link startUnpromptedToolCall} returns for a backend
 * tool that runs without approval, and as {@link startGatedToolCall} returns
 * for any other tool. `ended` when the reply refused to store the call.
 * @throws As {@link startGatedToolCall} throws.
 * @remarks A denied call never reaches the gate, so it never prompts the
 * person, even for a tool they saved as Just run. Only an MCP tool can be
 * marked destructive, so a call the policy requires approval of always names
 * a tool that passes the gate, and its round has one.
 */
function startToolCall(
  toolCall: CheckedToolCall,
  handling: ToolCallStartHandling
): StartedToolCall {
  const decision = decideToolCall(
    buildToolCallRequest(toolCall),
    handling.toolCallRules
  )
  switch (decision.effect) {
    case "deny":
      return denyToolCall(toolCall, decision, handling)
    case "require-approval":
      return startGatedToolCall(toolCall, decision, handling)
    case "allow":
      return runsWithoutApproval(toolCall.tool)
        ? startUnpromptedToolCall(toolCall, handling)
        : startGatedToolCall(toolCall, decision, handling)
  }
}

/**
 * Builds what the policy knows about one checked call from what the backend
 * trusts: the offered tool and the checked arguments.
 *
 * @param toolCall - Checked call.
 * @returns The request: destructive only for an MCP tool its server marks
 * so.
 */
function buildToolCallRequest(toolCall: CheckedToolCall): ToolCallRequest {
  const { tool } = toolCall
  return Object.freeze({
    action: Object.freeze({
      isDestructive: tool.runner === "mcp" && tool.mcpTool.isDestructive
    }),
    resource: Object.freeze({ arguments: toolCall.checkedCall.arguments })
  })
}

/**
 * Stores one checked call the policy denied as failed, with the denial the
 * model reads.
 *
 * @param toolCall - Checked call.
 * @param decision - The policy's denial, with the rule the call broke.
 * @param handling - The round's index and the reply's part sequence.
 * @returns `denied` with the message once stored; `ended` when the reply
 * refused it.
 */
function denyToolCall(
  toolCall: CheckedToolCall,
  decision: Extract<ToolCallDecision, { effect: "deny" }>,
  handling: ToolCallPartHandling
): ToolCallApproval {
  const message = createFailedToolCall(
    toolCall,
    formatToolCallDenial(decision.reason),
    Object.freeze({ policyDecision: decision, approvalMode: undefined }),
    handling
  )
  if (message === undefined) return ENDED_TOOL_CALL_APPROVAL
  return Object.freeze({ status: "denied", message })
}

/**
 * Starts one checked call through the round's gate, which stores it and
 * prompts the person when it may not go on without them, in one synchronous
 * step.
 *
 * @param toolCall - Checked call.
 * @param decision - The policy's answer: `require-approval` asks the person
 * even when they saved the tool as Just run; stored with the call, together
 * with the approval mode the gate applied.
 * @param handling - The round's gate and index, and the reply's part
 * sequence.
 * @returns `allowed` once the call is stored as running; `waiting` with the
 * approval the person's answer leads to, once the call is stored as awaiting
 * approval and the prompt is sent; `ended` when the reply refused to store
 * the call, which sends no prompt.
 * @throws If the round has no gate, which {@link hasGatedToolCall} rules
 * out for every call that reaches here.
 * @remarks A call allowed at once is stored as running in that step, and the
 * caller goes on without awaiting, so its run request keeps the model's
 * order among the round's sends.
 */
function startGatedToolCall(
  toolCall: CheckedToolCall,
  decision: GatedToolCallDecision,
  handling: GatedToolCallStartHandling
): StartedToolCall {
  if (handling.gate === undefined)
    throw new Error("The round has no approval gate for a call that needs one")
  const start = handling.gate.startToolCall(
    toolCall.checkedCall,
    decision.effect === "require-approval",
    (status, approvalMode) =>
      createStartedToolCall(
        toolCall,
        status,
        Object.freeze({ policyDecision: decision, approvalMode }),
        handling
      )
  )
  switch (start.status) {
    case "allowed":
      return ALLOWED_TOOL_CALL_APPROVAL
    case "ended":
      return ENDED_TOOL_CALL_APPROVAL
    case "prompted":
      return Object.freeze({
        status: "waiting",
        approval: handleToolCallApprovalAnswer(toolCall, start.answer, handling)
      })
  }
}

/**
 * Handles how a stored call's prompt ends: waits for it and stores it.
 *
 * @param toolCall - Checked call, stored as awaiting approval.
 * @param answer - Settles with the person's answer, with `expired` when the
 * prompt reached its time limit first, or with undefined when the reply was
 * stopped while the prompt waited; never rejects.
 * @param handling - The policy, read again for an allowed call, the reply's
 * cancellation, and its part sequence.
 * @returns As {@link updateAllowedToolCall} returns for an allowed call;
 * `rejected` with the rejection the model reads, once stored; `expired` with
 * the expiry the model reads, once the call is stored as failed; `ended`
 * when the reply was stopped while the prompt waited, or refused to store
 * the outcome.
 * @throws When reading the approved folders for the re-check does.
 */
async function handleToolCallApprovalAnswer(
  toolCall: CheckedToolCall,
  answer: Promise<ToolApprovalPromptOutcome | undefined>,
  handling: ToolCallAnswerHandling
): Promise<ToolCallApproval> {
  const settledAnswer = await answer
  if (settledAnswer === undefined) return ENDED_TOOL_CALL_APPROVAL
  switch (settledAnswer.status) {
    case "allowed":
      return updateAllowedToolCall(toolCall, handling)
    case "rejected":
      return updateRejectedToolCall(
        toolCall,
        settledAnswer,
        handling.replyParts
      )
    case "expired":
      return updateExpiredToolCall(toolCall, handling.replyParts)
  }
}

/**
 * Stores a waiting call the person allowed as running, then decides it again
 * by the rules with the approved folders read now, before it runs.
 *
 * @param toolCall - Checked call.
 * @param handling - The policy, the reply's cancellation, and its part
 * sequence.
 * @returns `allowed` once stored when the rules still let it go on;
 * `denied` with the denial the model reads, once the call is stored as
 * failed, when they now deny it, so it never runs; `ended` when the reply
 * refused either change, or was stopped while the folders were read, so the
 * call never runs.
 * @throws When reading the approved folders does.
 * @remarks Spec §4: an approval answers the exact call, and the gateway
 * checks it again against the policy's current state before it runs, so a
 * folder removed while the prompt waited is out of reach. Only the folders
 * can change; the other rules read the same arguments the same way. The
 * call is stored as running first, because a waiting call may change only
 * to running, rejected, or expired; nothing runs before this returns.
 */
async function updateAllowedToolCall(
  toolCall: CheckedToolCall,
  handling: ToolCallAnswerHandling
): Promise<ToolCallApproval> {
  const { replyParts } = handling
  if (!replyParts.updateReplyToolCall(toolCall.call.id, { status: "running" }))
    return ENDED_TOOL_CALL_APPROVAL
  const toolCallRules = await readToolCallRules(handling.toolCallPolicy)
  if (handling.abortSignal.aborted) return ENDED_TOOL_CALL_APPROVAL
  const decision = decideToolCall(buildToolCallRequest(toolCall), toolCallRules)
  if (decision.effect !== "deny") return ALLOWED_TOOL_CALL_APPROVAL
  const message = updateFinishedToolCall(
    toolCall,
    { status: "failed", content: formatToolCallDenial(decision.reason) },
    replyParts
  )
  if (message === undefined) return ENDED_TOOL_CALL_APPROVAL
  return Object.freeze({ status: "denied", message })
}

/**
 * Stores a waiting call that was not allowed, with why.
 *
 * @param toolCall - Checked call.
 * @param answer - The rejection: its content, which the model reads as the
 * client sent it, and its reason, stored with the call's decision.
 * @param replyParts - The reply's part sequence.
 * @returns `rejected` with the message once stored; `ended` when the reply
 * refused it. A network or MCP tool's rejection is cleaned first.
 */
function updateRejectedToolCall(
  toolCall: CheckedToolCall,
  answer: RejectedToolApprovalAnswer,
  replyParts: ReplyPartSequence
): ToolCallApproval {
  const result = formatToolCallResult(toolCall.tool, answer.content)
  const isStored = replyParts.updateReplyToolCall(toolCall.call.id, {
    status: "rejected",
    result,
    reason: answer.reason
  })
  if (!isStored) return ENDED_TOOL_CALL_APPROVAL
  return Object.freeze({
    status: "rejected",
    message: buildToolResultMessage(toolCall.call, result)
  })
}

/**
 * Stores a waiting call whose prompt reached its time limit as failed.
 *
 * @param toolCall - Checked call.
 * @param replyParts - The reply's part sequence.
 * @returns `expired` with the message the model reads once stored; `ended`
 * when the reply refused it, so the call never runs.
 */
function updateExpiredToolCall(
  toolCall: CheckedToolCall,
  replyParts: ReplyPartSequence
): ToolCallApproval {
  const isStored = replyParts.updateReplyToolCall(toolCall.call.id, {
    status: "expired",
    result: EXPIRED_TOOL_APPROVAL_RESULT
  })
  if (!isStored) return ENDED_TOOL_CALL_APPROVAL
  return Object.freeze({
    status: "expired",
    message: buildToolResultMessage(toolCall.call, EXPIRED_TOOL_APPROVAL_RESULT)
  })
}

/**
 * Stores a running call's outcome.
 *
 * @param toolCall - Checked call.
 * @param outcome - How the run ended.
 * @param replyParts - The reply's part sequence.
 * @returns The message carrying the text the model reads, once stored; or
 * undefined when the reply refused it. A network or MCP tool's result is
 * cleaned first.
 */
function updateFinishedToolCall(
  toolCall: CheckedToolCall,
  outcome: ToolCallRunOutcome,
  replyParts: ReplyPartSequence
): ToolResultMessage | undefined {
  const result = formatToolCallResult(toolCall.tool, outcome.content)
  const isStored = replyParts.updateReplyToolCall(
    toolCall.call.id,
    outcome.status === "succeeded"
      ? { status: "succeeded", result, sources: outcome.sources }
      : { status: "failed", result }
  )
  return isStored ? buildToolResultMessage(toolCall.call, result) : undefined
}

/**
 * Stores a call that cannot run as failed, with the message the model reads.
 *
 * @param toolCall - The call and the tool it names, if any.
 * @param message - Why the call cannot run.
 * @param decision - How it was decided: no policy answer when Lys's own
 * checks failed it, or the policy's denial.
 * @param handling - The round's index and the reply's part sequence.
 * @returns The message carrying the explanation, once stored; or undefined
 * when the reply refused it. A network or MCP tool's explanation is cleaned
 * first.
 */
function createFailedToolCall(
  toolCall: HandledToolCall,
  message: string,
  decision: ToolCallDecisionRecord,
  handling: ToolCallPartHandling
): ToolResultMessage | undefined {
  const result = formatToolCallResult(toolCall.tool, message)
  const isStored = handling.replyParts.createReplyToolCall({
    kind: "tool-call",
    id: toolCall.call.id,
    round: handling.round,
    toolName: toolCall.call.toolName,
    argumentText: toolCall.call.argumentText,
    decision,
    status: "failed",
    result
  })
  return isStored ? buildToolResultMessage(toolCall.call, result) : undefined
}

/**
 * Formats the text the model reads as one call's result.
 *
 * @param tool - Offered tool the call names, or undefined.
 * @param content - Text the tool, the client, or Lys gave.
 * @returns The text cleaned of invisible characters when the tool does more
 * than read this machine: it reaches the network, or it is an MCP tool,
 * whose server decides what it reaches. Otherwise the text unchanged.
 */
function formatToolCallResult(
  tool: OfferedTool | undefined,
  content: string
): string {
  return tool !== undefined && tool.agentTool.access !== "reads"
    ? formatNetworkToolResult(content)
    : content
}

/**
 * Formats what the model reads when it called a tool that was not offered.
 *
 * @param toolCall - Call naming a tool that was not offered.
 * @param handling - Tools the round offered and what the request names
 * about the tools the turn does not offer.
 * @returns The sentence {@link findUnofferedToolCallMessage} finds for a
 * tool the request names, or for any name while tool calls are off; when
 * the round offered `find_tools`, a sentence saying the tool cannot be
 * called now, naming every offered tool, and telling the model to ask
 * `find_tools` for another, without saying whether the turn has the tool;
 * otherwise a sentence naming the unknown tool and every offered tool, or
 * saying no tool can be called when none is offered.
 */
function formatMissingToolMessage(
  toolCall: ContextToolCall,
  handling: Pick<ToolCallHandling, "tools" | "unofferedTools">
): string {
  const unofferedMessage = findUnofferedToolCallMessage(
    handling.unofferedTools,
    toolCall.toolName
  )
  if (unofferedMessage !== undefined) return unofferedMessage
  if (handling.tools.size === 0)
    return `No tool is named "${toolCall.toolName}", and you can call no tool now.`
  const offeredNames = [...handling.tools.keys()].join(", ")
  if (handling.tools.has(FIND_TOOLS_TOOL_NAME))
    return `You cannot call "${toolCall.toolName}" now. The tools you can call are: ${offeredNames}. To get another tool, call ${FIND_TOOLS_TOOL_NAME} with what you need it for; the tools Armitage finds are offered to you from your next step.`
  return `No tool is named "${toolCall.toolName}". The tools you can call are: ${offeredNames}.`
}

/**
 * Builds the message that carries one call's result.
 *
 * @param toolCall - Call the result answers.
 * @param content - Text the model reads as the result.
 * @returns A frozen tool message.
 */
function buildToolResultMessage(
  toolCall: Readonly<{ id: string }>,
  content: string
): ToolResultMessage {
  return Object.freeze({ role: "tool", toolCallId: toolCall.id, content })
}

/**
 * Answers whether a call ended with a result.
 *
 * @param message - Result message, or undefined when the wait or run was
 * cancelled, or the reply refused to store the call.
 * @returns True when the call has a result.
 */
function isToolResultMessage(
  message: ToolResultMessage | undefined
): message is ToolResultMessage {
  return message !== undefined
}
