import type { ChatToolCall, ChatToolResult } from "@lys/protocol"
import type { OpenAIFunctionTool, ToolDefinition } from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type { BuiltInTool, TurnBuiltInTool } from "../tool/builtIn/builtInTool"
import { formatNetworkToolResult } from "../tool/networkToolResult"
import AgentTool from "../tool/tool"
import type ToolCallGate from "../toolApproval/toolCallGate"
import type { ToolApprovalRequest } from "../toolApproval/toolCallGate"
import type {
  ContextToolCall,
  ModelToolCall,
  ReplyContextMessage
} from "./replyModel"

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
    }>

/** Tools offered for one turn, by the name the model calls them by, in offer order. */
export type AgentToolset = ReadonlyMap<string, OfferedTool>

/** A round that ended with tool calls: the text it wrote and the calls it made. */
export type ToolCallRound = Readonly<{
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
 * for a reason other than an unreadable file.
 */
export type CreateToolCallGate = () => Promise<ToolCallGate>

/** What answering one round's calls needs from the turn. */
export type ToolCallRoundContext = Readonly<{
  /** Tools offered for the turn. */
  tools: AgentToolset
  /** Sends one allowed call of a client tool to run. */
  sendClientToolCall: SendClientToolCall
  /** Creates the approval gate every checked call of the round passes. */
  createToolCallGate: CreateToolCallGate
  /** Stops the reply; an allowed backend tool runs under it. */
  abortSignal: AbortSignal
}>

/** What handling one call of a round needs. */
type ToolCallHandling = Readonly<{
  /** Tools offered for the turn. */
  tools: AgentToolset
  /** Approval gate of the round. */
  gate: ToolCallGate
  /** Sends one allowed call of a client tool to run. */
  sendClientToolCall: SendClientToolCall
  /** Stops the reply; an allowed backend tool runs under it. */
  abortSignal: AbortSignal
}>

/** Context message that carries one tool call's result. */
type ToolResultMessage = Extract<ReplyContextMessage, { role: "tool" }>

/**
 * Builds the tools of one turn from the offered tools.
 *
 * @param clientTools - Validated definitions of the client tools, each name
 * once.
 * @param builtInTools - Backend tools found for the turn, each name once.
 * @returns The tools by name: client tools in offer order, then backend
 * tools in offer order.
 * @throws If a backend tool has the name of a client tool; the chat request
 * contract prevents that.
 */
export function buildAgentToolset(
  clientTools: readonly ToolDefinition[],
  builtInTools: readonly TurnBuiltInTool[]
): AgentToolset {
  const tools = new Map<string, OfferedTool>(
    clientTools.map(buildClientToolEntry)
  )
  for (const entry of builtInTools) {
    const agentTool = new AgentTool(entry.definition)
    if (tools.has(agentTool.name))
      throw new Error(`Tool ${agentTool.name} is offered twice`)
    tools.set(agentTool.name, {
      runner: "backend",
      agentTool,
      builtInTool: entry.tool
    })
  }
  return tools
}

/**
 * Builds the function tools a model is offered for one turn.
 *
 * @param tools - Tools of the turn.
 * @returns A frozen list in offer order; empty when the turn offers none.
 */
export function buildOfferedTools(
  tools: AgentToolset
): readonly OpenAIFunctionTool[] {
  return Object.freeze(
    [...tools.values()].map((tool) => tool.agentTool.buildAgentFormat())
  )
}

/**
 * Has every call of one round answered and builds the messages that add the
 * round to the context.
 *
 * @param round - The round's text and its calls in the model's order.
 * @param context - Tools, the client call sender, the gate factory, and the
 * reply's cancellation.
 * @returns The assistant message with the round's text and calls, then one
 * result message per call in the model's order; or undefined when the reply
 * was stopped while the gate was created, a call waited, or a backend tool
 * ran.
 * @throws If the turn offered no tools: the model called a tool it was not
 * offered, which ends the reply as failed, as before tools existed. Also
 * throws when the gate cannot be created, or a backend tool's run fails for
 * a reason other than Stop.
 * @remarks Each call gets a new UUIDv7. Calls of unknown tools and calls
 * whose arguments do not match are answered here, so the model reads what
 * went wrong; nobody is asked about them. Every other call passes the
 * round's gate: one created once for the round, so the saved choices are
 * read once. The gate's prompts and the run requests of calls allowed at
 * once are sent before the first wait, in the model's order, because each
 * call's handling runs synchronously up to its first send. Nothing runs
 * before its call is allowed.
 */
export async function handleToolCallRound(
  round: ToolCallRound,
  context: ToolCallRoundContext
): Promise<readonly ReplyContextMessage[] | undefined> {
  if (context.tools.size === 0)
    throw new Error("The model called a tool although none was offered")
  const toolCalls = Object.freeze(round.toolCalls.map(createContextToolCall))
  const gate = await context.createToolCallGate()
  if (context.abortSignal.aborted) return undefined
  const handling: ToolCallHandling = Object.freeze({
    tools: context.tools,
    gate,
    sendClientToolCall: context.sendClientToolCall,
    abortSignal: context.abortSignal
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
 * Builds the entry of one client tool in a turn's toolset.
 *
 * @param definition - Validated client tool definition.
 * @returns The tool's name and the tool.
 */
function buildClientToolEntry(
  definition: ToolDefinition
): [string, OfferedTool] {
  const agentTool = new AgentTool(definition)
  return [agentTool.name, Object.freeze({ runner: "client", agentTool })]
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
 * Has one call answered: through the round's gate and then the client or the
 * backend tool when it is a checked call of an offered tool, or here
 * otherwise.
 *
 * @param toolCall - Call with its identifier.
 * @param handling - Tools, the round's gate, the client call sender, and the
 * reply's cancellation.
 * @returns The message carrying the text the model reads as the result, or
 * undefined when the reply was stopped while the call waited or ran. The
 * result of a tool that reaches the network is cleaned of invisible
 * characters, whichever side answered and however the call ended.
 * @throws When a backend tool's run fails for a reason other than Stop.
 */
async function handleToolCall(
  toolCall: ContextToolCall,
  handling: ToolCallHandling
): Promise<ToolResultMessage | undefined> {
  const tool = handling.tools.get(toolCall.toolName)
  if (tool === undefined)
    return buildToolResultMessage(
      toolCall,
      formatUnknownToolMessage(toolCall, handling.tools)
    )
  const message = await handleOfferedToolCall(toolCall, tool, context)
  if (message === undefined || tool.agentTool.access !== "network")
    return message
  return buildToolResultMessage(
    toolCall,
    formatNetworkToolResult(message.content)
  )
}

/**
 * Has one call of an offered tool answered: by the client or the backend
 * tool when its arguments check out, or here otherwise.
 *
 * @param toolCall - Call with its identifier.
 * @param tool - Offered tool the call names.
 * @param context - Call senders and the reply's cancellation.
 * @returns The message carrying the result as the tool or the client gave
 * it, or undefined when the reply was stopped while the call waited or ran.
 * @throws When a backend tool's run fails for a reason other than Stop.
 */
async function handleOfferedToolCall(
  toolCall: ContextToolCall,
  tool: OfferedTool,
  context: ToolCallRoundContext
): Promise<ToolResultMessage | undefined> {
  const checkedArguments = tool.agentTool.parseCallArguments(
    toolCall.argumentText
  )
  if (checkedArguments.status === "invalid")
    return buildToolResultMessage(toolCall, checkedArguments.message)
  const checkedToolCall: ChatToolCall = Object.freeze({
    id: toolCall.id,
    toolName: toolCall.toolName,
    arguments: checkedArguments.arguments
  })
  switch (tool.runner) {
    case "client":
      return handleClientToolCall(checkedToolCall, handling)
    case "backend":
      return handleBuiltInToolCall(checkedToolCall, tool.builtInTool, handling)
  }
}

/**
 * Has one checked call of a client tool allowed, then has the client run it.
 *
 * @param toolCall - Checked call.
 * @param handling - The round's gate and the client call sender.
 * @returns The message carrying the client's result, or the person's
 * rejection; or undefined when the reply was stopped while the call waited.
 */
async function handleClientToolCall(
  toolCall: ChatToolCall,
  handling: ToolCallHandling
): Promise<ToolResultMessage | undefined> {
  const request = handling.gate.sendToolApprovalRequest(toolCall)
  const approval = isToolCallAllowedAtOnce(request)
    ? request
    : await request.answer
  if (approval === undefined) return undefined
  if (approval.status === "rejected")
    return buildToolResultMessage(toolCall, approval.content)
  const result = await handling.sendClientToolCall(toolCall)
  return result === undefined
    ? undefined
    : buildToolResultMessage(toolCall, result.content)
}

/**
 * Parses one checked call of a backend tool, has it allowed, and runs it.
 *
 * @param toolCall - Checked call.
 * @param builtInTool - Backend tool the call names.
 * @param handling - The round's gate and the reply's cancellation.
 * @returns The message carrying the run's text, the tool's explanation of
 * arguments it cannot run, or the person's rejection; or undefined when the
 * reply was stopped while the call waited or ran.
 * @throws When the run rejects although the reply was not stopped.
 * @remarks Arguments the tool cannot run are answered before the gate is
 * asked, so the person never sees a call that cannot succeed.
 */
async function handleBuiltInToolCall(
  toolCall: ChatToolCall,
  builtInTool: BuiltInTool,
  handling: ToolCallHandling
): Promise<ToolResultMessage | undefined> {
  const parsedCall = builtInTool.parseToolCall(toolCall.arguments)
  if (parsedCall.status === "invalid")
    return buildToolResultMessage(toolCall, parsedCall.message)
  const request = handling.gate.sendToolApprovalRequest(toolCall)
  const approval = isToolCallAllowedAtOnce(request)
    ? request
    : await request.answer
  if (approval === undefined) return undefined
  if (approval.status === "rejected")
    return buildToolResultMessage(toolCall, approval.content)
  try {
    const result = await parsedCall.runToolCall(handling.abortSignal)
    return buildToolResultMessage(toolCall, result.content)
  } catch (error) {
    if (handling.abortSignal.aborted) return undefined
    throw error
  }
}

/**
 * Answers whether the gate allowed a call without prompting the person.
 *
 * @param request - What asking the gate about the call did.
 * @returns True for `allowed`. The caller then goes on without awaiting, so
 * the call's run request is sent in the same step and keeps the model's
 * order among the round's sends.
 */
function isToolCallAllowedAtOnce(
  request: ToolApprovalRequest
): request is Extract<ToolApprovalRequest, { status: "allowed" }> {
  return request.status === "allowed"
}

/**
 * Formats what the model reads when it called a tool that was not offered.
 *
 * @param toolCall - Call naming the unknown tool.
 * @param tools - Tools offered for the turn.
 * @returns A sentence naming the unknown tool and every offered tool.
 */
function formatUnknownToolMessage(
  toolCall: ContextToolCall,
  tools: AgentToolset
): string {
  const offeredNames = [...tools.keys()].join(", ")
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
 * cancelled.
 * @returns True when the call has a result.
 */
function isToolResultMessage(
  message: ToolResultMessage | undefined
): message is ToolResultMessage {
  return message !== undefined
}
