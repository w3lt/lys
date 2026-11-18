import {
  stopConversationJobsApi,
  type StopConversationJobsApiRoute
} from "@lys/protocol"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { serializerCompiler } from "fastify-type-provider-zod"
import type { ConversationMetadataReader } from "../../conversation/capabilities"
import { createConversationNotFoundProblem } from "../../conversation/routes/notFound"

/**
 * What stopping the jobs of a conversation needs: the read of its metadata
 * and the person's stop of its jobs.
 */
type ConversationJobStops = Readonly<{
  /** Borrowed read of the conversation's metadata, which tells it is stored. */
  reader: ConversationMetadataReader
  /**
   * Stops every working job below a conversation for the person; resolves
   * once each stopped reply reached its stored final state.
   */
  stopConversationJobs: (conversationId: string) => Promise<void>
}>

/**
 * Registers the delegation endpoints: the one that stops the working jobs
 * of a conversation.
 *
 * @param app - Application with validation, conversation persistence, and
 * the person's stop of a conversation's jobs installed.
 * @returns A promise that resolves after route registration completes.
 * @throws If Fastify cannot register the route. The failure rejects the
 * promise, so `app.register` reports it rather than an uncaught exception.
 * @remarks The JSON responses are serialized with their Zod schemas. Fastify
 * answers a conversation identifier that is not a UUIDv7 with HTTP 400
 * before the handler runs.
 */
export default function registerDelegationRoutes(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    app.setSerializerCompiler(serializerCompiler)
    registerStopConversationJobsRoute(app)
    resolve()
  })
}

/**
 * Registers the endpoint that stops every working job of one conversation.
 *
 * @param app - Application with the response serializer, conversation
 * persistence, and the person's stop of a conversation's jobs installed;
 * the last two are read once, here.
 * @throws If route registration fails.
 */
function registerStopConversationJobsRoute(app: FastifyInstance): void {
  const jobStops: ConversationJobStops = Object.freeze({
    reader: app.conversationHistoryReader,
    stopConversationJobs: app.stopConversationJobs
  })
  app.route<StopConversationJobsApiRoute>({
    method: stopConversationJobsApi.method,
    url: stopConversationJobsApi.path,
    schema: {
      params: stopConversationJobsApi.params,
      response: stopConversationJobsApi.responses
    },
    handler: async (request, reply) =>
      handleStopConversationJobsRequest(request, reply, jobStops)
  })
}

/**
 * Stops every working job below a stored conversation, then sends a
 * bodyless success, or sends the declared missing-conversation problem.
 *
 * @param request - Validated conversation identifier.
 * @param reply - HTTP response owner.
 * @param jobStops - Borrowed read of the conversation's metadata, and the
 * person's stop of its jobs.
 * @returns Settlement after the response is sent: the success once each
 * stopped reply reached its stored final state, also when no job was
 * working.
 * @throws If storage access fails; nothing is stopped then.
 * @remarks Only the conversation's metadata is read, never its transcript.
 * The jobs are asked to stop right after the read, with no wait between
 * them, so the conversation cannot be deleted in between.
 */
async function handleStopConversationJobsRequest(
  request: FastifyRequest<StopConversationJobsApiRoute>,
  reply: FastifyReply<StopConversationJobsApiRoute>,
  jobStops: ConversationJobStops
): Promise<void> {
  const { conversationId } = request.params
  if (jobStops.reader.getConversationMetadata(conversationId) === undefined) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createConversationNotFoundProblem(conversationId, request.url))
    return
  }
  await jobStops.stopConversationJobs(conversationId)
  reply.code(204).send()
}
