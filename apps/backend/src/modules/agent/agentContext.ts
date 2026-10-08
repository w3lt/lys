import type { ConversationMessage } from "@lys/share"
import type { ReplyContextMessage } from "./replyModel"

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
 * Builds the context an agent sends to its model for one turn.
 * @param systemPrompt - The agent's own instructions, sent first.
 * @param history - Stored transcript before the turn, in conversation order.
 * @param userMessageContent - Text of the message the turn answers, sent last.
 * @returns The system prompt, the history's user messages, completed replies,
 * and nonempty interrupted replies in order, then the new message once. Failed,
 * streaming, and empty replies are left out; each message keeps only its role
 * and text.
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
      .map(({ role, content }) => ({ role, content })),
    { role: "user", content: userMessageContent }
  ]
}
