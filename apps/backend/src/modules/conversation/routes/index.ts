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
import type AttachmentFileStore from "../../attachment/attachmentFileStore"
import type {
  ConversationReader,
  ConversationTitleEditor,
  ConversationDeleter
} from "../capabilities"
import { parseConversationListOptions } from "../listOptions"
import { createConversationNotFoundProblem } from "./notFound"

/** What the delete endpoint does with attachment files. */
type AttachmentFileDeleter = Pick<
  AttachmentFileStore,
  "deleteConversationAttachments"
>

/**
 * Installs all protocol-defined history endpoints on a configured backend.
 * @param app - Application with validation, conversation persistence, and
 * the attachment file store installed.
 * @returns A promise resolving after route registration.
 * @throws If route registration fails. The failure rejects the promise, so
 * `app.register` reports it rather than an uncaught exception.
 */
export default function updateFastifyWithConversationRoutes(
  app: FastifyInstance
): Promise<void> {
  return new Promise((resolve) => {
    registerConversationRoutes(app)
    resolve()
  })
}

/**
 * Registers the list, read, title-update, and delete endpoints and the
 * response serializer they share.
 * @param app - Application with validation, conversation persistence, and
 * the attachment file store installed.
 * @throws If route registration fails.
 */
function registerConversationRoutes(app: FastifyInstance): void {
  app.setSerializerCompiler(serializerCompiler)
  const historyReader = app.conversationHistoryReader
  const historyEditor = app.conversationHistoryEditor
  const attachmentFiles = app.attachmentFileStore
  app.route<ListConversationsApiRoute>({
    method: listConversationsApi.method,
    url: listConversationsApi.path,
    schema: {
      querystring: listConversationsApi.querystring,
      response: { 200: listConversationsApi.response }
    },
    handler: (request) =>
      historyReader.listConversations(
        parseConversationListOptions(request.query)
      )
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
    handler: (request, reply) =>
      handleGetConversation(request, reply, historyReader)
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
    handler: (request, reply) =>
      handleUpdateConversationTitle(request, reply, historyEditor)
  })
  app.route<DeleteConversationApiRoute>({
    method: deleteConversationApi.method,
    url: deleteConversationApi.path,
    schema: {
      params: deleteConversationApi.params,
      response: deleteConversationApi.responses
    },
    handler: (request, reply) =>
      handleDeleteConversation(request, reply, historyEditor, attachmentFiles)
  })
}

/**
 * Sends a transcript with a 200, or sends the declared missing-conversation
 * problem.
 * @param request - Validated identifier.
 * @param reply - HTTP response owner.
 * @param history - Borrowed history reader valid for this request.
 * @throws If storage access fails.
 */
function handleGetConversation(
  request: FastifyRequest<GetConversationApiRoute>,
  reply: FastifyReply<GetConversationApiRoute>,
  history: ConversationReader
): void {
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
 * Persists a title replacement without changing activity order, then sends
 * the status-specific response.
 * @param request - Validated target and title.
 * @param reply - HTTP response owner.
 * @param history - Borrowed history edit access.
 * @throws If storage access fails.
 */
function handleUpdateConversationTitle(
  request: FastifyRequest<UpdateConversationTitleApiRoute>,
  reply: FastifyReply<UpdateConversationTitleApiRoute>,
  history: ConversationTitleEditor
): void {
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
 * Deletes the conversation and transcript, then its attachment files, before
 * sending a bodyless success, or sends the declared missing-conversation
 * problem.
 * @param request - Validated target identifier.
 * @param reply - HTTP response owner.
 * @param history - Borrowed history deletion access.
 * @param attachmentFiles - Borrowed deletion of the conversation's files.
 * @returns Settlement after the response is sent.
 * @throws If storage access fails.
 * @remarks The rows are deleted first; the files are removed once the rows
 * are gone, so a conversation is never left without its files. When the
 * files cannot be removed, the failure is logged with its cause and the
 * deletion still succeeds: the conversation is gone, and the files stay
 * under the attachments directory.
 */
async function handleDeleteConversation(
  request: FastifyRequest<DeleteConversationApiRoute>,
  reply: FastifyReply<DeleteConversationApiRoute>,
  history: ConversationDeleter,
  attachmentFiles: AttachmentFileDeleter
): Promise<void> {
  const { conversationId } = request.params
  if (!history.deleteConversation(conversationId)) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createConversationNotFoundProblem(conversationId, request.url))
    return
  }
  try {
    await attachmentFiles.deleteConversationAttachments(conversationId)
  } catch (error) {
    request.log.error(
      { err: error },
      "The deleted conversation's attachment files could not be removed"
    )
  }
  reply.code(204).send()
}
