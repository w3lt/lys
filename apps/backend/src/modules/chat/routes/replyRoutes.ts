import {
  chatReplyEventsApi,
  stopChatReplyApi,
  type ChatReplyEvent,
  type ChatReplyEventsApiRoute,
  type StopChatReplyApiRoute
} from "@lys/protocol"
import type { ConversationAssistantMessage } from "@lys/share"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { ConversationReader } from "../../conversation/capabilities"
import { createConversationNotFoundProblem } from "../../conversation/routes/notFound"
import ReplyEventSubscription from "../replyEventSubscription"
import type ReplyGenerationRegistry from "../replyGenerationRegistry"
import {
  createChatReplyNotFoundProblem,
  createChatReplyNotGeneratingProblem
} from "./replyProblems"
import { createEventSender, openReplyEventStream } from "./share"

/** Capabilities the reply routes borrow for their registered lifetime. */
type ChatReplyRouteDependencies = Readonly<{
  /** Stored conversations read for a reply snapshot. */
  history: ConversationReader
  /** Running generations; borrowed, never disposed here. */
  generations: ReplyGenerationRegistry
}>

/**
 * Installs the endpoints that follow and stop one reply's generation.
 *
 * @param app - Backend with SSE, validation, and conversation persistence.
 * @param generations - Registry shared with the chat route; its owner
 * disposes it.
 * @returns Settlement after route registration.
 * @throws If route registration fails.
 */
export default async function updateFastifyWithChatReplyRoutes(
  app: FastifyInstance,
  generations: ReplyGenerationRegistry
): Promise<void> {
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
 * snapshot plus later deltas equal the stored reply. Closing this stream does
 * not affect the generation.
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
  subscription.handleStreamEvent({
    type: "reply-snapshot",
    conversationTitle: conversation.title,
    assistantMessage
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
