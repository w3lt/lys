import {
  chatReplyNotFoundProblemSchema,
  chatReplyNotGeneratingProblemSchema,
  chatToolCallNotPendingProblemSchema,
  type ChatReplyNotFoundProblem,
  type ChatReplyNotGeneratingProblem,
  type ChatToolCallNotPendingProblem
} from "@lys/protocol"

/**
 * Creates the caller-safe missing-reply response.
 *
 * @param assistantMessageId - Validated UUIDv7 the conversation does not hold.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by reply-events consumers.
 */
export function createChatReplyNotFoundProblem(
  assistantMessageId: string,
  instance: string
): ChatReplyNotFoundProblem {
  const { shape } = chatReplyNotFoundProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: `Reply ${assistantMessageId} was not found.`,
    instance
  }
}

/**
 * Creates the caller-safe response for stopping a reply that is not generating.
 *
 * @param assistantMessageId - Validated UUIDv7 with no running generation.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by reply-stop consumers.
 */
export function createChatReplyNotGeneratingProblem(
  assistantMessageId: string,
  instance: string
): ChatReplyNotGeneratingProblem {
  const { shape } = chatReplyNotGeneratingProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: `Reply ${assistantMessageId} is not generating.`,
    instance
  }
}

/**
 * Creates the caller-safe response for answering a tool call that is not
 * waiting for an answer.
 *
 * @param callId - Validated UUIDv7 of a call that is unknown, already
 * answered, or whose reply ended.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by tool-result consumers.
 */
export function createChatToolCallNotPendingProblem(
  callId: string,
  instance: string
): ChatToolCallNotPendingProblem {
  const { shape } = chatToolCallNotPendingProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: `Tool call ${callId} is not waiting for an answer.`,
    instance
  }
}
