import {
  chatBackendToolUnavailableProblemSchema,
  chatReplyNotFoundProblemSchema,
  chatReplyNotGeneratingProblemSchema,
  chatToolCallNotPendingProblemSchema,
  type BackendToolUnavailableReason,
  type ChatBackendToolUnavailableProblem,
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
 * waiting for that answer.
 *
 * @param callId - Validated UUIDv7 of a call that is unknown, already
 * answered, waiting for the other kind of answer, or whose reply ended.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by tool-result and tool-approval
 * consumers.
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
    detail: `Tool call ${callId} is not waiting for this answer.`,
    instance
  }
}

/** Caller-safe clause for each reason a backend tool cannot run. */
const BACKEND_TOOL_UNAVAILABLE_CLAUSES = Object.freeze({
  "api-key-missing": "no Tavily API key is saved.",
  "api-key-invalid": "the saved Tavily API key is not valid.",
  "settings-unreadable": "Lys could not read its settings file.",
  "page-reader-not-ready": "vmo, Lys's page reader, is not ready."
} satisfies Readonly<Record<BackendToolUnavailableReason, string>>)

/**
 * Creates the caller-safe response for offering a backend tool that cannot
 * run now.
 *
 * @param toolName - Name of the first offered tool that cannot run.
 * @param reason - Why it cannot run.
 * @param instance - Request path identifying this occurrence.
 * @returns The strict problem accepted by chat consumers; it never holds the
 * key or anything read from the settings file.
 */
export function createChatBackendToolUnavailableProblem(
  toolName: string,
  reason: BackendToolUnavailableReason,
  instance: string
): ChatBackendToolUnavailableProblem {
  const { shape } = chatBackendToolUnavailableProblemSchema.unwrap()
  return {
    type: shape.type.value,
    title: shape.title.value,
    status: shape.status.value,
    detail: `${toolName} is unavailable: ${BACKEND_TOOL_UNAVAILABLE_CLAUSES[reason]}`,
    instance,
    toolName,
    reason
  }
}
