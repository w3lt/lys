import type { ConversationMessage } from "@lys/share"
import { lazy, memo, type ReactElement } from "react"

const UserMessage = lazy(() => import("./UserMessage"))
const LysMessage = lazy(() => import("./LysMessage"))

/** Properties accepted by {@link CompletedChatMessage}. */
export type CompletedChatMessageProps = {
  /** Terminal or user message selected for role-specific presentation. */
  readonly message: ConversationMessage
}

/**
 * Selects role-specific presentation for one completed transcript message.
 *
 * @remarks Primary category: presentational. The shared message object is
 * immutable; memoization skips body work while its identity is unchanged.
 * @param props - Stable completed message selected by the transcript.
 * @returns The rendered role-specific transcript message.
 */
function CompletedChatMessage({
  message
}: CompletedChatMessageProps): ReactElement {
  if (message.role === "user") return <UserMessage message={message} />

  return <LysMessage message={message} />
}

export default memo(CompletedChatMessage)
