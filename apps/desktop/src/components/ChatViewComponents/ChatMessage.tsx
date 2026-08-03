import { type ConversationMessage } from "@lys/share"
import { lazy } from "react"
import type { ReactElement } from "react"

const UserMessage = lazy(() => import("./UserMessage"))
const LysMessage = lazy(() => import("./LysMessage"))

/** Properties accepted by {@link ChatMessage}. */
export type ChatMessageProps = {
  /** Conversation message selected for role-specific presentation. */
  readonly message: ConversationMessage
  /** Interrupts the message when it is the active assistant reply. */
  readonly onStop: () => void
}

/**
 * Selects role-specific presentation for one transcript message.
 *
 * @param props - Message and lifecycle control to pass to assistant content.
 * @returns The rendered role-specific transcript message.
 */
export default function ChatMessage({
  message,
  onStop
}: ChatMessageProps): ReactElement {
  if (message.role === "user") return <UserMessage message={message} />

  return <LysMessage message={message} onStop={onStop} />
}
