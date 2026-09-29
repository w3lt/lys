import type { ChatApiRoute } from "@lys/protocol"
import type { FastifyReply, FastifyRequest } from "fastify"
import type ReplyEventSubscription from "./replyEventSubscription"

/** Fastify reply that owns the protocol-defined chat SSE connection. */
export type ChatRouteReply = FastifyReply<ChatApiRoute>

/** Fastify request whose body has been validated by the chat route contract. */
export type ChatRouteRequest = FastifyRequest<ChatApiRoute>

/** SSE capability of one route reply, borrowed for one stream. */
export type ReplySse = FastifyReply["sse"]

/**
 * Creates the writer that sends typed events on one SSE connection.
 *
 * @typeParam TStreamEvent - Event union of the route's stream contract.
 * @param sse - Borrowed SSE connection; the route keeps ownership.
 * @returns An async writer that uses each event's `type` as the SSE event
 * name and resolves after Fastify accepts the write. It rejects when the
 * connection has already closed. A write waiting for the connection to drain
 * never settles if the client disconnects meanwhile.
 */
export function createEventSender<
  TStreamEvent extends Readonly<{ type: string }>
>(sse: Pick<ReplySse, "send">): (event: TStreamEvent) => Promise<void> {
  return async (event) => {
    await sse.send({ event: event.type, data: event })
  }
}

/**
 * Ties one follower to its SSE connection and settles when the stream ends.
 *
 * @typeParam TStreamEvent - Event union written by the follower.
 * @param sse - Borrowed SSE connection of the current route reply.
 * @param subscription - Follower that writes to that connection.
 * @returns A promise that settles once the client disconnected, or once the
 * follower ended — because its generation settled or a write failed — and its
 * accepted writes settled. It never rejects. The route then returns and the
 * SSE plugin ends the response.
 * @remarks A client disconnect ends only this follower; the generation
 * continues. A write still waiting for the connection to drain at the
 * disconnect never settles, so the stream does not wait for it; the write is
 * abandoned with the connection. A connection that closed before this call
 * ends the follower at once, and its queued writes fail without waiting.
 */
export async function openReplyEventStream<TStreamEvent>(
  sse: Pick<ReplySse, "onClose" | "isConnected">,
  subscription: ReplyEventSubscription<TStreamEvent>
): Promise<void> {
  const disconnection = Promise.withResolvers<void>()
  sse.onClose(() => {
    subscription.close()
    disconnection.resolve()
  })
  if (!sse.isConnected) subscription.close()
  await Promise.race([subscription.closed, disconnection.promise])
}
