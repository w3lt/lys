import type { ChatApiRoute, ChatApiStreamEvent } from "@lys/protocol"
import type { FastifyReply, FastifyRequest } from "fastify"

export type ChatRouteReply = FastifyReply<ChatApiRoute>
export type ChatRouteRequest = FastifyRequest<ChatApiRoute>

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
 * @param event - Protocol event whose type also becomes the SSE event name.
 * @returns A promise that resolves after Fastify writes the event.
 */
export function createEventSender(reply: ChatRouteReply) {
  return async (event: ChatApiStreamEvent) => {
    await reply.sse.send({
      event: event.type,
      data: event
    })
  }
}
