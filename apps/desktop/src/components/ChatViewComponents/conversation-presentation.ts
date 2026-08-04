import {
  type CompletedConversationMessage,
  isCompletedConversationMessage,
  type ReadonlyConversationMessage,
  type StreamingConversationAssistantMessage
} from "@/lib/store/chat-view/conversation-transitions"

/** Transcript presentation containing no active streaming assistant. */
export type CompletedConversationPresentation = {
  /** Selects a completed-only transcript. */
  readonly kind: "completed-only"
  /** Ordered user and terminal assistant messages. */
  readonly completedMessages: readonly CompletedConversationMessage[]
}

/** Transcript presentation with one active streaming assistant tail. */
export type StreamingConversationPresentation = {
  /** Selects a completed prefix followed by one streaming assistant. */
  readonly kind: "streaming-tail"
  /** Ordered user and terminal assistant messages before the active reply. */
  readonly completedMessages: readonly CompletedConversationMessage[]
  /** Final assistant message accepting streamed content. */
  readonly streamingMessage: StreamingConversationAssistantMessage
}

/** Complete valid presentation states derived from one conversation. */
export type ConversationPresentation =
  CompletedConversationPresentation | StreamingConversationPresentation

/**
 * Selects and validates the completed prefix of a transcript.
 *
 * @param messages - Messages expected to contain no streaming assistant.
 * @returns A frozen completed-message list preserving message identities.
 * @throws If a streaming assistant appears in the completed prefix.
 */
function createCompletedConversationMessages(
  messages: readonly ReadonlyConversationMessage[]
): readonly CompletedConversationMessage[] {
  const completedMessages: CompletedConversationMessage[] = []

  for (const message of messages) {
    if (!isCompletedConversationMessage(message)) {
      throw new Error("A streaming assistant must be the transcript tail")
    }
    completedMessages.push(message)
  }

  return Object.freeze(completedMessages)
}

/**
 * Derives one lifecycle-refined transcript presentation without storing state.
 *
 * @param messages - Ordered immutable messages from the active conversation.
 * @returns A completed-only or streaming-tail presentation.
 * @throws If a streaming assistant occurs before the final position.
 */
export function createConversationPresentation(
  messages: readonly ReadonlyConversationMessage[]
): ConversationPresentation {
  const finalMessage = messages.at(-1)
  if (
    finalMessage?.role === "assistant" &&
    finalMessage.status === "streaming"
  ) {
    const completedMessages = createCompletedConversationMessages(
      messages.slice(0, -1)
    )

    return Object.freeze({
      kind: "streaming-tail",
      completedMessages,
      streamingMessage: finalMessage
    })
  }

  const completedMessages = createCompletedConversationMessages(messages)
  return Object.freeze({ kind: "completed-only", completedMessages })
}
