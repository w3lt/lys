import type { ConversationMessage } from "@lys/share"
import type { ContextToolCall, ReplyContextMessage } from "./replyModel"

/** Tool calls of a stored reply, which never carries any. */
const NO_CONTEXT_TOOL_CALLS: readonly ContextToolCall[] = Object.freeze([])

/**
 * Selects stored messages that can supply conversation context.
 * @param message - One persisted transcript message.
 * @returns True for user text, completed replies, and nonempty interrupted replies.
 */
function shouldIncludeContextMessage(message: ConversationMessage): boolean {
  if (message.role === "user") return true
  if (message.content.length === 0) return false
  return message.status === "completed" || message.status === "interrupted"
}

/**
 * Builds the context message of one stored message.
 * @param message - Stored user message or assistant reply.
 * @returns Its role and text; a reply carries no tool calls.
 */
function buildStoredContextMessage(
  message: ConversationMessage
): ReplyContextMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content }
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        toolCalls: NO_CONTEXT_TOOL_CALLS
      }
  }
}

/**
 * Builds the context an agent sends to its model for one turn.
 * @param systemPrompt - The agent's own instructions, sent first.
 * @param history - Stored transcript before the turn, in conversation order.
 * @param userMessageContent - Text of the message the turn answers, sent last.
 * @returns The system prompt, the history's user messages, completed replies,
 * and nonempty interrupted replies in order, then the new message once. Failed,
 * streaming, and empty replies are left out; each message keeps only its role
 * and text, and a reply carries no tool calls.
 */
export function buildAgentContext(
  systemPrompt: string,
  history: readonly ConversationMessage[],
  userMessageContent: string
): readonly ReplyContextMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...history
      .filter(shouldIncludeContextMessage)
      .map(buildStoredContextMessage),
    { role: "user", content: userMessageContent }
  ]
}
