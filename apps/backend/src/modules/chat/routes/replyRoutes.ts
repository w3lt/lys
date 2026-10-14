import {
  chatReplyEventsApi,
  sendChatToolApprovalApi,
  sendChatToolResultApi,
  stopChatReplyApi,
  type ChatReplyEvent,
  type ChatReplyEventsApiRoute,
  type ChatToolResultPathParams,
  type SendChatToolApprovalApiRoute,
  type SendChatToolResultApiRoute,
  type StopChatReplyApiRoute
} from "@lys/protocol"
import type { ConversationAssistantMessage } from "@lys/share"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { ConversationReader } from "../../conversation/capabilities"
import { createConversationNotFoundProblem } from "../../conversation/routes/notFound"
import type {
  PendingToolCallSnapshot,
  ToolCallAnswer,
  ToolCallAnswerOutcome
} from "../pendingToolCalls"
import ReplyEventSubscription from "../replyEventSubscription"
import type ReplyGenerationRegistry from "../replyGenerationRegistry"
import {
  createChatReplyNotFoundProblem,
  createChatReplyNotGeneratingProblem,
  createChatToolCallNotPendingProblem
} from "./replyProblems"
import { createEventSender, openReplyEventStream } from "./share"

/** Pending calls of a reply that is not generating. */
const NO_PENDING_TOOL_CALLS: PendingToolCallSnapshot = Object.freeze({
  toolCalls: Object.freeze([]),
  toolApprovals: Object.freeze([])
})

/** Capabilities the reply routes borrow for their registered lifetime. */
type ChatReplyRouteDependencies = Readonly<{
  /** Stored conversations read for a reply snapshot. */
  history: ConversationReader
  /** Running generations; borrowed, never disposed here. */
  generations: ReplyGenerationRegistry
}>

/**
 * Installs the endpoints that follow, stop, and answer the tool calls and
 * approval prompts of one reply's generation.
 *
 * @param app - Backend with SSE, validation, and conversation persistence.
 * @param generations - Registry shared with the chat route; its owner
 * disposes it.
 * @throws If route registration fails.
 */
export default function updateFastifyWithChatReplyRoutes(
  app: FastifyInstance,
  generations: ReplyGenerationRegistry
): void {
  const dependencies = {
    history: app.conversationHistoryReader,
    generations
  }
  app.route<ChatReplyEventsApiRoute>({
    method: chatReplyEventsApi.method,
    url: chatReplyEventsApi.path,
    sse: "only",
    schema: { params: chatReplyEventsApi.params },
    handler: async (request, reply) =>
      handleChatReplyEventsRequest(request, reply, dependencies)
  })
  app.route<StopChatReplyApiRoute>({
    method: stopChatReplyApi.method,
    url: stopChatReplyApi.path,
    schema: { params: stopChatReplyApi.params },
    handler: async (request, reply) =>
      handleStopChatReplyRequest(request, reply, generations)
  })
  app.route<SendChatToolResultApiRoute>({
    method: sendChatToolResultApi.method,
    url: sendChatToolResultApi.path,
    bodyLimit: sendChatToolResultApi.bodyLimitBytes,
    schema: {
      params: sendChatToolResultApi.params,
      body: sendChatToolResultApi.body
    },
    handler: (request, reply) =>
      handleSendChatToolResultRequest(request, reply, generations)
  })
  app.route<SendChatToolApprovalApiRoute>({
    method: sendChatToolApprovalApi.method,
    url: sendChatToolApprovalApi.path,
    schema: {
      params: sendChatToolApprovalApi.params,
      body: sendChatToolApprovalApi.body
    },
    handler: (request, reply) =>
      handleSendChatToolApprovalRequest(request, reply, generations)
  })
}

/**
 * Sends the stored reply as a snapshot, then follows its generation while
 * one runs.
 *
 * @param request - Validated reply identifiers.
 * @param reply - SSE or pre-stream problem response owner.
 * @param dependencies - Borrowed history reader and registry.
 * @returns Settlement after the stream ends, or after a missing-conversation
 * or missing-reply response.
 * @throws Before the stream starts, if reading the conversation fails or the
 * registry is closed because shutdown began.
 * @remarks Reading the snapshot and registering the follower happen in one
 * synchronous step, and every delta is stored before it is sent, so the
 * snapshot plus later deltas equal the stored reply. The snapshot's pending
 * calls and prompts are read in the same step, so each reaches this follower
 * once: in the snapshot or as a later `tool-call` or `tool-approval` event.
 * Closing this stream does not affect the generation.
 */
async function handleChatReplyEventsRequest(
  request: FastifyRequest<ChatReplyEventsApiRoute>,
  reply: FastifyReply<ChatReplyEventsApiRoute>,
  { history, generations }: ChatReplyRouteDependencies
): Promise<void> {
  const { conversationId, assistantMessageId } = request.params
  const conversation = history.getConversation(conversationId)
  if (conversation === undefined) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createConversationNotFoundProblem(conversationId, request.url))
    return
  }
  const assistantMessage = conversation.messages.find(
    (message): message is ConversationAssistantMessage =>
      message.role === "assistant" && message.id === assistantMessageId
  )
  if (assistantMessage === undefined) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createChatReplyNotFoundProblem(assistantMessageId, request.url))
    return
  }

  const generation = generations.findReplyGeneration(request.params)
  const subscription = new ReplyEventSubscription<ChatReplyEvent>(
    createEventSender<ChatReplyEvent>(reply.sse)
  )
  const pendingToolCalls = generation?.pendingToolCalls ?? NO_PENDING_TOOL_CALLS
  subscription.handleStreamEvent({
    type: "reply-snapshot",
    conversationTitle: conversation.title,
    assistantMessage,
    pendingToolCalls: pendingToolCalls.toolCalls,
    pendingToolApprovals: pendingToolCalls.toolApprovals
  })
  if (generation === undefined) subscription.close()
  else generation.openSubscription(subscription)
  await openReplyEventStream(reply.sse, subscription)
}

/**
 * Stops one reply's running generation and answers after the reply is stored
 * final.
 *
 * @param request - Validated reply identifiers.
 * @param reply - HTTP response owner.
 * @param generations - Borrowed registry.
 * @returns Settlement after the 204 or the not-generating problem is sent.
 * @throws If the registry is closed because shutdown began; nothing is
 * stopped.
 */
async function handleStopChatReplyRequest(
  request: FastifyRequest<StopChatReplyApiRoute>,
  reply: FastifyReply<StopChatReplyApiRoute>,
  generations: ReplyGenerationRegistry
): Promise<void> {
  const generation = generations.findReplyGeneration(request.params)
  if (generation === undefined) {
    reply
      .type("application/problem+json")
      .code(409)
      .send(
        createChatReplyNotGeneratingProblem(
          request.params.assistantMessageId,
          request.url
        )
      )
    return
  }

  await generation.stopReply()
  reply.code(204).send()
}

/**
 * Resumes a reply with the client's result for one call it was sent to run.
 *
 * @param request - Validated call identifiers and result.
 * @param reply - HTTP response owner.
 * @param generations - Borrowed registry.
 * @throws If the registry is closed because shutdown began; nothing is
 * answered.
 * @remarks Sends the 204 or the not-pending problem before returning. Only a
 * failed result's content reaches the model; its reason is logged at debug
 * level.
 */
function handleSendChatToolResultRequest(
  request: FastifyRequest<SendChatToolResultApiRoute>,
  reply: FastifyReply<SendChatToolResultApiRoute>,
  generations: ReplyGenerationRegistry
): void {
  const outcome = resolveReplyToolCall(
    request.params,
    request.body,
    generations
  )
  if (outcome === "not-pending") {
    sendToolCallNotPendingProblem(reply, request.params.callId, request.url)
    return
  }
  if (request.body.status === "failed")
    request.log.debug(
      { toolCallId: request.params.callId, reason: request.body.reason },
      "Tool call was answered as failed"
    )
  reply.code(204).send()
}

/**
 * Resumes a reply with the person's answer to one of its approval prompts.
 *
 * @param request - Validated call identifiers and answer.
 * @param reply - HTTP response owner.
 * @param generations - Borrowed registry.
 * @throws If the registry is closed because shutdown began; nothing is
 * answered.
 * @remarks Sends the 204 or the not-pending problem before returning. After
 * `allowed`, the reply runs a backend tool itself or sends a client tool's
 * call to run. Only a rejection's content reaches the model; its reason is
 * logged at debug level.
 */
function handleSendChatToolApprovalRequest(
  request: FastifyRequest<SendChatToolApprovalApiRoute>,
  reply: FastifyReply<SendChatToolApprovalApiRoute>,
  generations: ReplyGenerationRegistry
): void {
  const outcome = resolveReplyToolCall(
    request.params,
    request.body,
    generations
  )
  if (outcome === "not-pending") {
    sendToolCallNotPendingProblem(reply, request.params.callId, request.url)
    return
  }
  if (request.body.status === "rejected")
    request.log.debug(
      { toolCallId: request.params.callId, reason: request.body.reason },
      "Tool call was not allowed"
    )
  reply.code(204).send()
}

/**
 * Hands one answer to the generation of the addressed reply.
 *
 * @param target - Validated call, reply, and conversation identifiers.
 * @param answer - Validated result or approval answer.
 * @param generations - Borrowed registry.
 * @returns `accepted` when the reply waited for that answer; `not-pending`
 * when no generation runs for the reply or it does not wait for that answer.
 * @throws If the registry is closed because shutdown began.
 */
function resolveReplyToolCall(
  target: ChatToolResultPathParams,
  answer: ToolCallAnswer,
  generations: ReplyGenerationRegistry
): ToolCallAnswerOutcome {
  const generation = generations.findReplyGeneration(target)
  return generation?.resolveToolCall(target.callId, answer) ?? "not-pending"
}

/**
 * Sends the problem response for an answer no call waits for.
 *
 * @param reply - Response owner; the response has not started.
 * @param callId - Validated identifier of the answered call.
 * @param instance - Request path identifying this occurrence.
 */
function sendToolCallNotPendingProblem(
  reply: FastifyReply<
    SendChatToolResultApiRoute | SendChatToolApprovalApiRoute
  >,
  callId: string,
  instance: string
): void {
  reply
    .type("application/problem+json")
    .code(409)
    .send(createChatToolCallNotPendingProblem(callId, instance))
}
