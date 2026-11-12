import { activityEventsApi, type ActivityEvent } from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
  createEventSender,
  openReplyEventStream
} from "../../chat/routes/share"
import type ActivityHub from "../activityHub"

/**
 * Registers the activity routes.
 *
 * @param app - Application instance that receives the activity stream
 * endpoint, with SSE support and the singleton services installed.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route. The failure rejects the
 * promise, so `app.register` reports it rather than an uncaught exception.
 * @remarks The route follows the application's activity hub, which the
 * application closes when it shuts down; nothing is closed here.
 */
export default function registerActivityRoutes(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerActivityEventsRoute(app)
    resolve()
  })
}

/**
 * Registers the endpoint that follows the application's activity hub over
 * SSE.
 *
 * @param app - Application with SSE support and the activity hub installed;
 * the hub is read once, here.
 * @throws If route registration fails.
 */
function registerActivityEventsRoute(app: FastifyInstance): void {
  const hub = app.activityHub
  app.route({
    method: activityEventsApi.method,
    url: activityEventsApi.path,
    sse: "only",
    handler: async (request, reply) =>
      handleActivityEventsRequest(request, reply, hub)
  })
}

/**
 * Follows the activity hub on one SSE connection until the hub closes or
 * the client disconnects.
 *
 * @param request - Request of the client, which carries no input.
 * @param reply - Owner of the SSE connection.
 * @param hub - Borrowed activity hub.
 * @returns Settlement after the stream ended; it never rejects.
 * @remarks The stream starts with the hub's snapshot and then carries every
 * event the hub sends. Following changes nothing, and closing the stream
 * ends only this client's observation. Nothing is replayed: a client the
 * hub disconnected because it fell too far behind connects again for a new
 * snapshot. Once the hub is closed, the response ends at once without an
 * event. Connecting and closing each write one info log line. Like a
 * reply's stream, it shows the pending tool calls to every caller of the
 * loopback API.
 */
async function handleActivityEventsRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  hub: Pick<ActivityHub, "openStream">
): Promise<void> {
  const stream = hub.openStream(createEventSender<ActivityEvent>(reply.sse))
  request.log.info("Activity stream connected")
  await openReplyEventStream(reply.sse, stream)
  request.log.info("Activity stream closed")
}
