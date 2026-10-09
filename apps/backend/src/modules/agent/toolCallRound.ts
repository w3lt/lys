import type { ChatToolCall, ChatToolResult } from "@lys/protocol"
import type { OpenAIFunctionTool, ToolDefinition } from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import AgentTool from "../tool/tool"
import type {
  ContextToolCall,
  ModelToolCall,
  ReplyContextMessage
} from "./replyModel"

/** Tools offered for one turn, by the name the model calls them by, in offer order. */
export type AgentToolset = ReadonlyMap<string, AgentTool>

/** A round that ended with tool calls: the text it wrote and the calls it made. */
export type ToolCallRound = Readonly<{
  /** Text the round wrote before its calls; empty when it wrote none. */
  text: string
  /** Calls in the model's order; at least one. */
  toolCalls: readonly ModelToolCall[]
}>

/**
 * Sends one checked tool call to the client and waits for its answer; resolves
 * with undefined when the reply was stopped while the call waited.
 */
export type SendToolCall = (
  toolCall: ChatToolCall
) => Promise<ChatToolResult | undefined>

/** Context message that carries one tool call's result. */
type ToolResultMessage = Extract<ReplyContextMessage, { role: "tool" }>

/**
 * Builds the tools of one turn from the offered definitions.
 *
 * @param definitions - Validated definitions, each name once.
 * @returns The tools by name, in offer order.
 */
export function buildAgentToolset(
  definitions: readonly ToolDefinition[]
): AgentToolset {
  return new Map(definitions.map(buildAgentToolEntry))
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
    [...tools.values()].map((tool) => tool.buildAgentFormat())
  )
}

/**
 * Has every call of one round answered and builds the messages that add the
 * round to the context.
 *
 * @param round - The round's text and its calls in the model's order.
 * @param tools - Tools offered for the turn.
 * @param sendToolCall - Sends one checked call to the client.
 * @returns The assistant message with the round's text and calls, then one
 * result message per call in the model's order; or undefined when the reply
 * was stopped while a call waited.
 * @throws If the turn offered no tools: the model called a tool it was not
 * offered, which ends the reply as failed, as before tools existed.
 * @remarks Each call gets a new UUIDv7. Calls of unknown tools and calls
 * whose arguments do not match are answered here, so the model reads what
 * went wrong; the client never sees them. Every checked call is sent before
 * the first wait, in the model's order, because each call's handling runs
 * synchronously up to its send.
 */
export async function handleToolCallRound(
  round: ToolCallRound,
  tools: AgentToolset,
  sendToolCall: SendToolCall
): Promise<readonly ReplyContextMessage[] | undefined> {
  if (tools.size === 0)
    throw new Error("The model called a tool although none was offered")
  const toolCalls = Object.freeze(round.toolCalls.map(createContextToolCall))
  const toolMessages = await Promise.all(
    toolCalls.map((toolCall) => handleToolCall(toolCall, tools, sendToolCall))
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
 * Builds the entry of one tool in a turn's toolset.
 *
 * @param definition - Validated tool definition.
 * @returns The tool's name and the tool.
 */
function buildAgentToolEntry(definition: ToolDefinition): [string, AgentTool] {
  const tool = new AgentTool(definition)
  return [tool.name, tool]
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
 * Has one call answered: by the client when it is a checked call of an
 * offered tool, or here otherwise.
 *
 * @param toolCall - Call with its identifier.
 * @param tools - Tools offered for the turn.
 * @param sendToolCall - Sends one checked call to the client.
 * @returns The message carrying the text the model reads as the result, or
 * undefined when the reply was stopped while the call waited.
 */
async function handleToolCall(
  toolCall: ContextToolCall,
  tools: AgentToolset,
  sendToolCall: SendToolCall
): Promise<ToolResultMessage | undefined> {
  const tool = tools.get(toolCall.toolName)
  if (tool === undefined)
    return buildToolResultMessage(
      toolCall,
      formatUnknownToolMessage(toolCall, tools)
    )
  const checkedArguments = tool.parseCallArguments(toolCall.argumentText)
  if (checkedArguments.status === "invalid")
    return buildToolResultMessage(toolCall, checkedArguments.message)
  const checkedToolCall: ChatToolCall = Object.freeze({
    id: toolCall.id,
    toolName: toolCall.toolName,
    arguments: checkedArguments.arguments
  })
  const result = await sendToolCall(checkedToolCall)
  return result === undefined
    ? undefined
    : buildToolResultMessage(toolCall, result.content)
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
  toolCall: ContextToolCall,
  content: string
): ToolResultMessage {
  return Object.freeze({ role: "tool", toolCallId: toolCall.id, content })
}

/**
 * Answers whether a call ended with a result.
 *
 * @param message - Result message, or undefined when the wait was cancelled.
 * @returns True when the call has a result.
 */
function isToolResultMessage(
  message: ToolResultMessage | undefined
): message is ToolResultMessage {
  return message !== undefined
}
