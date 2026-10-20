import type { ConversationSource } from "@lys/share"
import { memo, type ReactElement } from "react"

import type { ReadonlyConversationMessage } from "@/lib/store/chat-view/conversation-transitions"

import LysMessage from "./LysMessage"
import UserMessage from "./UserMessage"

/** Properties accepted by {@link ChatMessage}. */
export type ChatMessageProps = {
  /** User message, or reply that is streaming or has ended. */
  readonly message: ReadonlyConversationMessage
  /** Name of the agent that answers the conversation. */
  readonly speakerName: string
  /**
   * Sources a reply may cite, in number order; see {@link LysMessage}. Empty
   * for a user message.
   */
  readonly sources: readonly ConversationSource[]
  /**
   * One-based position of a reply among the transcript's replies; 0 for a
   * user message.
   */
  readonly replyNumber: number
}

/**
 * Answers whether two renders of a {@link ChatMessage} would show the same
 * thing.
 *
 * @param previous - Properties of the earlier render.
 * @param next - Properties of the next render.
 * @returns True when the message object, the speaker's name, and the reply's
 * position are the same, and the source lists hold the same source objects
 * in the same order; the transcript builds a new list for every render, so
 * comparing the lists themselves would always differ.
 */
function isSameChatMessage(
  previous: ChatMessageProps,
  next: ChatMessageProps
): boolean {
  return (
    previous.message === next.message &&
    previous.speakerName === next.speakerName &&
    previous.replyNumber === next.replyNumber &&
    previous.sources.length === next.sources.length &&
    previous.sources.every((source, index) => source === next.sources[index])
  )
}

/**
 * Selects role-specific presentation for one transcript message.
 *
 * @remarks The transcript keys every message, the streaming reply included,
 * by its identifier, so when a reply ends the same element updates in place:
 * its open disclosures stay open and focus inside it stays. Shared messages
 * and sources are immutable; memoization skips body work while
 * {@link isSameChatMessage} holds, so a reply whose sources did not change
 * is not rendered again when another reply finds sources.
 * @param props - The message, the name its replies are shown under, the
 * sources a reply may cite, and a reply's position.
 * @returns The rendered user message, streaming reply, or ended reply.
 */
function ChatMessage({
  message,
  speakerName,
  sources,
  replyNumber
}: ChatMessageProps): ReactElement {
  if (message.role === "user") return <UserMessage message={message} />
  if (message.status === "streaming")
    return (
      <LysMessage
        kind="streaming"
        message={message}
        replyNumber={replyNumber}
        sources={sources}
        speakerName={speakerName}
      />
    )
  return (
    <LysMessage
      kind="terminal"
      message={message}
      replyNumber={replyNumber}
      sources={sources}
      speakerName={speakerName}
    />
  )
}

export default memo(ChatMessage, isSameChatMessage)
