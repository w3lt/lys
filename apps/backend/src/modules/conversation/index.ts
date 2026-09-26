import {
  listConversationsApi,
  getConversationApi,
  updateConversationTitleApi,
  deleteConversationApi,
  type ListConversationsApiRoute,
  type GetConversationApiRoute,
  type UpdateConversationTitleApiRoute,
  type DeleteConversationApiRoute
} from "@lys/protocol"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { serializerCompiler } from "fastify-type-provider-zod"
import type {
  ConversationReader,
  ConversationTitleEditor,
  ConversationDeleter
} from "./capabilities"
import { parseConversationListOptions } from "../../di/services/conversationService/utils"
import { createConversationNotFoundProblem } from "./notFound"

/**
 * Installs all protocol-defined history endpoints on a configured backend.
 * @param app - Application with validation and conversation persistence installed.
 * @returns A promise resolving after route registration.
 * @throws If acquiring history access or route registration fails.
 */
export default async function updateFastifyWithConversationRoutes(
  app: FastifyInstance
): Promise<void> {
  app.setSerializerCompiler(serializerCompiler)
  const history = app.conversationService.createHistoryAccess()
  app.route<ListConversationsApiRoute>({
    method: listConversationsApi.method,
    url: listConversationsApi.path,
    schema: {
      querystring: listConversationsApi.querystring,
      response: { 200: listConversationsApi.response }
    },
    handler: async (request) =>
      history.listConversations(parseConversationListOptions(request.query))
  })
  app.route<GetConversationApiRoute>({
    method: getConversationApi.method,
    url: getConversationApi.path,
    schema: {
      params: getConversationApi.params,
      response: {
        200: getConversationApi.response,
        ...getConversationApi.responses
      }
    },
    handler: async (request, reply) =>
      handleGetConversation(request, reply, history)
  })
  app.route<UpdateConversationTitleApiRoute>({
    method: updateConversationTitleApi.method,
    url: updateConversationTitleApi.path,
    schema: {
      params: updateConversationTitleApi.params,
      body: updateConversationTitleApi.body,
      response: {
        200: updateConversationTitleApi.response,
        ...updateConversationTitleApi.responses
      }
    },
    handler: async (request, reply) =>
      handleUpdateConversationTitle(request, reply, history)
  })
  app.route<DeleteConversationApiRoute>({
    method: deleteConversationApi.method,
    url: deleteConversationApi.path,
    schema: {
      params: deleteConversationApi.params,
      response: deleteConversationApi.responses
    },
    handler: async (request, reply) =>
      handleDeleteConversation(request, reply, history)
  })
}

/**
 * Reads a transcript or sends the declared missing-conversation problem.
 * @param request - Validated identifier.
 * @param reply - HTTP response owner.
 * @param history - Borrowed history access valid for this request.
 * @returns The status-specific HTTP reply.
 * @throws If storage access fails.
 */
async function handleGetConversation(
  request: FastifyRequest<GetConversationApiRoute>,
  reply: FastifyReply<GetConversationApiRoute>,
  history: ConversationReader
): Promise<void> {
  const conversation = history.getConversation(request.params.conversationId)
  if (conversation === undefined) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(
        createConversationNotFoundProblem(
          request.params.conversationId,
          request.url
        )
      )
    return
  }
  reply.code(200).send(conversation)
}

/**
 * Persists a title replacement without changing activity order.
 * @param request - Validated target and title.
 * @param reply - HTTP response owner.
 * @param history - Borrowed history edit access.
 * @returns A promise resolving after the status-specific response is sent.
 * @throws If storage access fails.
 */
async function handleUpdateConversationTitle(
  request: FastifyRequest<UpdateConversationTitleApiRoute>,
  reply: FastifyReply<UpdateConversationTitleApiRoute>,
  history: ConversationTitleEditor
): Promise<void> {
  const metadata = history.updateConversationTitle(
    request.params.conversationId,
    request.body.title
  )
  if (metadata === undefined) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(
        createConversationNotFoundProblem(
          request.params.conversationId,
          request.url
        )
      )
    return
  }
  reply.code(200).send(metadata)
}

/**
 * Deletes the conversation and transcript before sending a bodyless success.
 * @param request - Validated target identifier.
 * @param reply - HTTP response owner.
 * @param history - Borrowed history deletion access.
 * @returns A promise resolving after the deletion outcome is sent.
 * @throws If storage access fails.
 */
async function handleDeleteConversation(
  request: FastifyRequest<DeleteConversationApiRoute>,
  reply: FastifyReply<DeleteConversationApiRoute>,
  history: ConversationDeleter
): Promise<void> {
  if (!history.deleteConversation(request.params.conversationId)) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(
        createConversationNotFoundProblem(
          request.params.conversationId,
          request.url
        )
      )
    return
  }
  reply.code(204).send()
}
