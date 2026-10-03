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
 * Builds inference context from the saved system prompt, the tone of the side
 * answering the turn, and the earlier transcript.
 * @param turn - Snapshot preceding the new pair, plus the current user message.
 * @param personalityPrompt - Tone prompt of the side answering this turn,
 * appended after a blank line to the saved system prompt in the one system
 * message; it is not part of the stored conversation.
 * @returns Ordered inference messages with the current user appended exactly once.
 */
export function buildChatMessages(
  turn: ConversationTurn,
  personalityPrompt: string
): CompleteChatOptions["messages"] {
  return [
    {
      role: "system",
      content: `${turn.conversation.systemPrompt}\n\n${personalityPrompt}`
    },
    ...turn.conversation.messages
      .filter(shouldIncludeContextMessage)
      .map(({ role, content }) => ({ role, content })),
    { role: "user", content: turn.userMessage.content }
  ]
}
