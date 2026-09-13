import type { ConversationMessage } from "@lys/share"
import type { CompleteChatOptions } from "../../../di/services/chatService"
import type { ConversationTurn } from "../../../di/services/conversationService/share"

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
 * Builds inference context from the saved system prompt and earlier transcript.
 * @param turn - Snapshot preceding the new pair, plus the current user message.
 * @returns Ordered inference messages with the current user appended exactly once.
 */
export function buildChatMessages(
  turn: ConversationTurn
): CompleteChatOptions["messages"] {
  return [
    { role: "system", content: turn.conversation.systemPrompt },
    ...turn.conversation.messages
      .filter(shouldIncludeContextMessage)
      .map(({ role, content }) => ({ role, content })),
    { role: "user", content: turn.userMessage.content }
  ]
}
