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
 * name and resolves after Fastify accepts the write; it rejects once the
 * connection has closed.
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
 * @returns A promise that settles after the follower ended — because its
 * generation settled, the client disconnected, or a write failed — and its
 * accepted writes settled. It never rejects. The route then returns and the
 * SSE plugin ends the response.
 * @remarks A client disconnect ends only this follower; the generation
 * continues. A connection that closed before this call ends the follower at
 * once.
 */
export async function openReplyEventStream<TStreamEvent>(
  sse: Pick<ReplySse, "onClose" | "isConnected">,
  subscription: ReplyEventSubscription<TStreamEvent>
): Promise<void> {
  sse.onClose(() => {
    subscription.close()
  })
  if (!sse.isConnected) subscription.close()
  await subscription.closed
}
