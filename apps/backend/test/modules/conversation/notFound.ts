import {
  conversationNotFoundProblemSchema,
  type ConversationNotFoundProblem
} from "@lys/protocol"

/**
 * Creates the shared caller-safe missing-conversation response.
 * @param conversationId - Validated UUIDv7 that could not be found.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by conversation and chat consumers.
 */
export function createConversationNotFoundProblem(
  conversationId: string,
  instance: string
): ConversationNotFoundProblem {
  return {
    type: conversationNotFoundProblemSchema.unwrap().shape.type.value,
    title: conversationNotFoundProblemSchema.unwrap().shape.title.value,
    status: conversationNotFoundProblemSchema.unwrap().shape.status.value,
    detail: `Conversation ${conversationId} was not found.`,
    instance
  }
}
