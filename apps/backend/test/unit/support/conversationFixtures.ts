import type {
  ConversationAssistantMessage,
  ConversationMessage,
  ConversationUserMessage
} from "@lys/share"
import type { ConversationTurn } from "../../../src/modules/chat/persistence"

/**
 * Creates a syntactically valid UUIDv7 whose last group encodes `sequence`.
 *
 * @param sequence - Non-negative integer below 2^48; larger values sort later
 * when the timestamp groups are equal.
 * @returns A lowercase UUIDv7 string.
 */
export function createFixtureUuidV7(sequence: number): string {
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`
}

/** Conversation identity used by turn fixtures. */
export const FIXTURE_CONVERSATION_ID = createFixtureUuidV7(1)

/** Timestamp shared by turn fixtures. */
export const FIXTURE_TIMESTAMP = "2026-01-02T03:04:05.678Z"

/**
 * Creates a stored user message.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Non-empty authored text.
 * @returns A valid user message.
 */
export function createUserMessage(
  sequence: number,
  content: string
): ConversationUserMessage {
  return {
    id: createFixtureUuidV7(sequence),
    role: "user",
    content,
    createdAt: FIXTURE_TIMESTAMP
  }
}

/** Lifecycle fields that distinguish assistant-message fixtures. */
export type AssistantMessageFixtureState =
  | Readonly<{ status: "completed"; finishReason: "stop" | "length" }>
  | Readonly<{ status: "streaming" | "interrupted" | "failed" }>

/**
 * Creates a stored assistant message.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Stored reply text, possibly empty.
 * @param state - Lifecycle status and, for completed replies, finish reason.
 * @returns A valid assistant message from model `fixture-model`.
 */
export function createAssistantMessage(
  sequence: number,
  content: string,
  state: AssistantMessageFixtureState
): ConversationAssistantMessage {
  return {
    id: createFixtureUuidV7(sequence),
    role: "assistant",
    model: "fixture-model",
    content,
    status: state.status,
    finishReason: state.status === "completed" ? state.finishReason : null,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/** Values that distinguish one turn fixture from another. */
export type ConversationTurnFixture = Readonly<{
  /** Code of the conversation's agent. */
  agentCode: string
  /** Transcript before the new turn. */
  earlierMessages: readonly ConversationMessage[]
  /** Content of the new user message. */
  userMessageContent: string
}>

/**
 * Creates a persisted turn for an untitled existing conversation.
 *
 * @param fixture - Agent code, earlier transcript, and new user content.
 * @returns A turn whose new pair uses identity sequences 1001 and 1002.
 */
export function createConversationTurn(
  fixture: ConversationTurnFixture
): ConversationTurn {
  return {
    conversation: {
      id: FIXTURE_CONVERSATION_ID,
      title: null,
      agentCode: fixture.agentCode,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      messages: [...fixture.earlierMessages]
    },
    userMessage: createUserMessage(1001, fixture.userMessageContent),
    assistantMessage: createAssistantMessage(1002, "", {
      status: "streaming"
    }),
    isNewConversation: false
  }
}
