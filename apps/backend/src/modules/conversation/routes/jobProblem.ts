import {
  conversationIsJobProblemSchema,
  type ConversationIsJobProblem
} from "@lys/protocol"

/**
 * Creates the shared caller-safe response that refuses the person's change
 * to a job.
 * @param conversationId - Validated UUIDv7 of the job the request addresses.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by conversation and chat consumers.
 */
export function createConversationIsJobProblem(
  conversationId: string,
  instance: string
): ConversationIsJobProblem {
  return {
    type: conversationIsJobProblemSchema.unwrap().shape.type.value,
    title: conversationIsJobProblemSchema.unwrap().shape.title.value,
    status: conversationIsJobProblemSchema.unwrap().shape.status.value,
    detail: `Conversation ${conversationId} is a job. A job can be read and stopped, and nothing else.`,
    instance
  }
}
