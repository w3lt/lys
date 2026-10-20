import type {
  ConversationAssistantMessage,
  ConversationMessage,
  ReplyPart,
  ToolCallReplyPart
} from "@lys/share"
import type { ContextToolCall, ReplyContextMessage } from "./replyModel"

/** A stored tool call that has the result the model read. */
type AnsweredToolCallReplyPart = Extract<
  ToolCallReplyPart,
  { status: "succeeded" | "failed" | "rejected" }
>

/**
 * Selects stored replies that can supply conversation context.
 * @param message - One persisted stored reply.
 * @returns True for completed and interrupted replies; failed and streaming
 * replies are left out.
 */
function isContextReply(message: ConversationAssistantMessage): boolean {
  return message.status === "completed" || message.status === "interrupted"
}

/**
 * Answers whether a stored part is a tool call with a result.
 * @param part - One part of a stored reply.
 * @returns True for a call that succeeded, failed, or was rejected.
 */
function isAnsweredToolCall(
  part: ReplyPart
): part is AnsweredToolCallReplyPart {
  return part.kind === "tool-call" && "result" in part
}

/**
 * Groups a stored reply's parts by the round they belong to.
 * @param parts - Parts in stored order, whose rounds never decrease.
 * @returns Each round's parts in stored order, rounds in order.
 */
function buildReplyPartRounds(
  parts: readonly ReplyPart[]
): readonly (readonly ReplyPart[])[] {
  const rounds: ReplyPart[][] = []
  for (const part of parts) {
    const lastRound = rounds.at(-1)
    if (lastRound?.[0]?.round === part.round) lastRound.push(part)
    else rounds.push([part])
  }
  return rounds
}

/**
 * Builds the context form of a stored call.
 * @param part - Stored call with a result.
 * @returns The call with its identity, name, and the model's argument text.
 */
function buildContextToolCall(
  part: AnsweredToolCallReplyPart
): ContextToolCall {
  return {
    id: part.id,
    toolName: part.toolName,
    argumentText: part.argumentText
  }
}

/**
 * Builds the context messages of one stored round.
 * @param parts - The round's parts in stored order.
 * @returns One assistant message with the round's text and its answered
 * calls, then one result message per answered call; none when the round has
 * neither text nor an answered call. Reasoning and calls without a result
 * are left out.
 */
function buildStoredRoundContextMessages(
  parts: readonly ReplyPart[]
): readonly ReplyContextMessage[] {
  const text = parts
    .flatMap((part) => (part.kind === "text" ? [part.content] : []))
    .join("")
  const answeredCalls = parts.filter(isAnsweredToolCall)
  if (text === "" && answeredCalls.length === 0) return []
  const assistantMessage: ReplyContextMessage = {
    role: "assistant",
    content: text,
    toolCalls: answeredCalls.map(buildContextToolCall)
  }
  const resultMessages = answeredCalls.map((part): ReplyContextMessage => ({
    role: "tool",
    toolCallId: part.id,
    content: part.result
  }))
  return [assistantMessage, ...resultMessages]
}

/**
 * Builds the context messages of one stored message.
 * @param message - Stored user message or reply.
 * @returns The user message's text; a context reply's rounds as
 * {@link buildStoredRoundContextMessages} builds them; nothing for another
 * reply.
 */
function buildStoredContextMessages(
  message: ConversationMessage
): readonly ReplyContextMessage[] {
  if (message.role === "user")
    return [{ role: "user", content: message.content }]
  if (!isContextReply(message)) return []
  return buildReplyPartRounds(message.parts).flatMap(
    buildStoredRoundContextMessages
  )
}

/**
 * Builds the context an agent sends to its model for one turn.
 * @param systemPrompt - The agent's own instructions, sent first.
 * @param history - Stored transcript before the turn, in conversation order.
 * @param userMessageContent - Text of the message the turn answers, sent last.
 * @returns The system prompt, then the history's user messages and the rounds
 * of its completed and interrupted replies in order, then the new message
 * once. Each stored round sends its text and the tool calls that have a
 * result, followed by those results; reasoning, calls without a result, and
 * rounds with neither text nor such a call are left out, and failed and
 * streaming replies are left out whole.
 */
export function buildAgentContext(
  systemPrompt: string,
  history: readonly ConversationMessage[],
  userMessageContent: string
): readonly ReplyContextMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...history.flatMap(buildStoredContextMessages),
    { role: "user", content: userMessageContent }
  ]
}

/**
 * Counts the stored messages a turn's context includes.
 * @param history - Stored transcript before the turn, in conversation order.
 * @returns How many of its messages {@link buildAgentContext} sends: every
 * user message, and each completed or interrupted reply with a round that
 * sends text or a tool call with a result. A reply counts once, however many
 * context messages its rounds and tool results become.
 */
export function calculateAgentContextHistoryMessageCount(
  history: readonly ConversationMessage[]
): number {
  return history.filter(
    (message) => buildStoredContextMessages(message).length > 0
  ).length
}
