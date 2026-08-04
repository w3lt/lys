import type {
  ConversationAssistantMessage,
  ConversationMetadata,
  ConversationUserMessage
} from "@lys/share"
import type ConversationService from "../../../di/services/conversationService"
import { ConversationNotFoundError } from "../../../utils/errors"

export type ConversationTurnCreationOptions = {
  conversationId?: string | undefined
  userMessageContent: string
  model: string
  conversationService: ConversationService
}

export default class ConversationTurn {
  #userMessage: ConversationUserMessage
  #assistantMessage: ConversationAssistantMessage
  #conversation: ConversationMetadata
  #isNewConversation: boolean
  #model: string

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
    this.#model = model

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

  get userMessage() {
    return this.#userMessage
  }

  get assistantMessage() {
    return this.#assistantMessage
  }

  get conversation() {
    return this.#conversation
  }

  get isNewConversation() {
    return this.#isNewConversation
  }

  get model() {
    return this.#model
  }
}
