import type {
  ConversationAssistantMessage,
  ConversationMetadata,
  ConversationUserMessage
} from "@lys/share"
import type ConversationService from "../../../di/services/conversationService"
import { ConversationNotFoundError } from "../../../utils/errors"

/** Inputs required to create and persist one conversation turn. */
export type ConversationTurnCreationOptions = {
  /** Existing conversation identifier; omission or an empty string starts one. */
  conversationId?: string | undefined
  /** Non-empty user content persisted as the first message in the turn. */
  userMessageContent: string
  /** Model identifier stored on the streaming assistant message. */
  model: string
  /** Conversation persistence owner used for metadata and message writes. */
  conversationService: ConversationService
}

/**
 * Owns the invariant-bearing metadata and persisted messages for one turn.
 *
 * @remarks Primary category: invariant owner. The instance owns the selected
 * conversation metadata, user message, assistant message, and whether the
 * turn created a conversation. Construction performs synchronous persistence:
 * it creates or retrieves metadata, then inserts the user and streaming
 * assistant messages in that order. The instance is single-owner and exposes
 * only synchronous read accessors; all later lifecycle updates remain owned by
 * {@link ConversationService}.
 */
export default class ConversationTurn {
  /** Persisted user message owned by this turn boundary. */
  #userMessage: ConversationUserMessage
  /** Persisted streaming assistant message owned by this turn boundary. */
  #assistantMessage: ConversationAssistantMessage
  /** Conversation metadata selected or created during construction. */
  #conversation: ConversationMetadata
  /** Whether construction created rather than continued a conversation. */
  #isNewConversation: boolean

  /**
   * Creates and persists the user/assistant pair for one conversation turn.
   *
   * @param options - Conversation selection, message content, model, and
   * persistence owner.
   * @throws {@link ConversationNotFoundError} when a supplied conversation
   * identifier does not resolve to metadata. Persistence failures from the
   * conversation service propagate; no rollback is performed here.
   */
  constructor({
    model,
    userMessageContent,
    conversationId,
    conversationService
  }: ConversationTurnCreationOptions) {
    const isNewConversation = !conversationId
    const conversationMetadata = isNewConversation
      ? conversationService.createConversation()
      : conversationService.getConversationMetadata({
          id: conversationId
        })

    if (!conversationMetadata) {
      throw new ConversationNotFoundError()
    }

    this.#conversation = conversationMetadata

    this.#userMessage = conversationService.addUserMessageToConversation({
      conversationId: conversationMetadata.id,
      userMessageContent
    })

    this.#assistantMessage =
      conversationService.addAssistantMessageToConversation({
        conversationId: conversationMetadata.id,
        assistantMessageContent: "",
        model,
        status: "streaming"
      })

    this.#isNewConversation = isNewConversation
  }

  /**
   * Gets the persisted user message created for this turn.
   *
   * @returns The user message owned by this turn.
   */
  get userMessage() {
    return this.#userMessage
  }

  /**
   * Gets the persisted streaming assistant message created for this turn.
   *
   * @returns The assistant message whose state is updated by the chat task.
   */
  get assistantMessage() {
    return this.#assistantMessage
  }

  /**
   * Gets the conversation metadata selected for this turn.
   *
   * @returns The persisted conversation metadata receiving both messages.
   */
  get conversation() {
    return this.#conversation
  }

  /**
   * Reports whether this turn created a conversation rather than continued one.
   *
   * @returns `true` when the creation input omitted or emptied the identifier.
   */
  get isNewConversation() {
    return this.#isNewConversation
  }
}
