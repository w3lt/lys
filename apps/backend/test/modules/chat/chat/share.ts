import type { ChatApiRoute, ChatApiStreamEvent } from "@lys/protocol"
import type { FastifyReply, FastifyRequest } from "fastify"

/** Fastify reply that owns the protocol-defined chat SSE connection. */
export type ChatRouteReply = FastifyReply<ChatApiRoute>

/** Fastify request whose body has been validated by the chat route contract. */
export type ChatRouteRequest = FastifyRequest<ChatApiRoute>

/**
 * Binds client disconnects to cancellation of work owned by one chat request.
 *
 * @param reply - Active chat reply whose SSE lifecycle owns the cancellation.
 * @returns A signal aborted when the SSE connection closes; the returned
 * signal does not own or release the reply itself.
 */
export function createAbortSignal(reply: ChatRouteReply) {
  const abortController = new AbortController()
  reply.sse.onClose(() => {
    abortController.abort()
  })

  return abortController.signal
}

/**
 * Sends one typed chat event through the active SSE connection.
 *
 * @param reply - Active chat reply whose SSE connection receives events.
 * @returns An async sender that accepts a protocol event, uses its type as the
 * SSE event name, and resolves after Fastify accepts the event write.
 * Concurrent callers may interleave because chat and title tasks share the
 * connection.
 */
export function createEventSender(reply: ChatRouteReply) {
  return async (event: ChatApiStreamEvent) => {
    await reply.sse.send({
      event: event.type,
      data: event
    })
  }
}
