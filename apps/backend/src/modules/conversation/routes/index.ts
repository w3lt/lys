import {
  listConversationsApi,
  getConversationApi,
  updateConversationTitleApi,
  deleteConversationApi,
  type ConversationIsJobProblem,
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
  ConversationMetadataReader,
  ConversationTitleEditor,
  ConversationDeleter
} from "../capabilities"
import { parseConversationListOptions } from "../listOptions"
import { createConversationIsJobProblem } from "./jobProblem"
import { createConversationNotFoundProblem } from "./notFound"

/** What the delete endpoint does with attachment files. */
type AttachmentFileDeleter = Pick<
  AttachmentFileStore,
  "deleteConversationAttachments"
>

/**
 * What renaming a conversation needs: its metadata's read and its title's
 * editor.
 */
type ConversationRenaming = Readonly<{
  /** Borrowed read of its metadata, which tells whether it is a job. */
  reader: ConversationMetadataReader
  /** Borrowed history title editing access. */
  history: ConversationTitleEditor
}>

/**
 * What deleting a conversation needs: its metadata's read, its rows'
 * deleter, and its files'.
 */
type ConversationDeletion = Readonly<{
  /** Borrowed read of its metadata, which tells whether it is a job. */
  reader: ConversationMetadataReader
  /** Borrowed history deletion access. */
  history: ConversationDeleter
  /** Borrowed deletion of the conversation's files. */
  attachmentFiles: AttachmentFileDeleter
}>

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
  registerUpdateConversationTitleRoute(app)
  registerDeleteConversationRoute(app)
}

/**
 * Registers the title-update endpoint.
 * @param app - Application with validation, the response serializer, and
 * conversation persistence installed.
 * @throws If route registration fails.
 */
function registerUpdateConversationTitleRoute(app: FastifyInstance): void {
  const renaming: ConversationRenaming = Object.freeze({
    reader: app.conversationHistoryReader,
    history: app.conversationHistoryEditor
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
      handleUpdateConversationTitle(request, reply, renaming)
  })
}

/**
 * Registers the delete endpoint.
 * @param app - Application with validation, the response serializer,
 * conversation persistence, and the attachment file store installed.
 * @throws If route registration fails.
 */
function registerDeleteConversationRoute(app: FastifyInstance): void {
  const deletion: ConversationDeletion = Object.freeze({
    reader: app.conversationHistoryReader,
    history: app.conversationHistoryEditor,
    attachmentFiles: app.attachmentFileStore
  })
  app.route<DeleteConversationApiRoute>({
    method: deleteConversationApi.method,
    url: deleteConversationApi.path,
    schema: {
      params: deleteConversationApi.params,
      response: deleteConversationApi.responses
    },
    handler: (request, reply) =>
      handleDeleteConversation(request, reply, deletion)
  })
}

/**
 * Finds the problem that refuses the person's change to a conversation
 * because it is a job.
 * @param history - Borrowed metadata reader valid for this request.
 * @param conversationId - Validated identifier the request addresses.
 * @param instance - Request path identifying this occurrence.
 * @returns The conversation-is-job problem for a job; undefined for a main
 * conversation, and for a conversation that is not stored, which the change
 * itself then reports as missing.
 * @throws If storage access fails or the stored metadata is invalid.
 * @remarks Only the conversation's metadata is read, never its transcript,
 * so a conversation whose transcript cannot be read can still be changed.
 */
function findConversationIsJobProblem(
  history: ConversationMetadataReader,
  conversationId: string,
  instance: string
): ConversationIsJobProblem | undefined {
  const metadata = history.getConversationMetadata(conversationId)
  if (metadata === undefined || metadata.parentConversationId === null)
    return undefined
  return createConversationIsJobProblem(conversationId, instance)
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
 * the status-specific response, or sends the declared conversation-is-job
 * or missing-conversation problem.
 * @param request - Validated target and title.
 * @param reply - HTTP response owner.
 * @param renaming - Borrowed read of the conversation's metadata and edit
 * of its title.
 * @throws If storage access fails.
 * @remarks The conversation's metadata is read first: a job is refused and
 * keeps its title. The read and the edit run in one synchronous step, so the
 * conversation cannot change between them.
 */
function handleUpdateConversationTitle(
  request: FastifyRequest<UpdateConversationTitleApiRoute>,
  reply: FastifyReply<UpdateConversationTitleApiRoute>,
  renaming: ConversationRenaming
): void {
  const { conversationId } = request.params
  const jobProblem = findConversationIsJobProblem(
    renaming.reader,
    conversationId,
    request.url
  )
  if (jobProblem !== undefined) {
    reply.type("application/problem+json").code(409).send(jobProblem)
    return
  }
  const metadata = renaming.history.updateConversationTitle(
    conversationId,
    request.body.title
  )
  if (metadata === undefined) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createConversationNotFoundProblem(conversationId, request.url))
    return
  }
  reply.code(200).send(metadata)
}

/**
 * Deletes the conversation and transcript, then its attachment files, before
 * sending a bodyless success, or sends the declared conversation-is-job or
 * missing-conversation problem.
 * @param request - Validated target identifier.
 * @param reply - HTTP response owner.
 * @param deletion - Borrowed read of the conversation's metadata, and
 * deletion of its rows and of its files.
 * @returns Settlement after the response is sent.
 * @throws If storage access fails.
 * @remarks The conversation's metadata is read first: a job is refused and
 * stays stored, with its files. The read and the deletion of the rows run in
 * one synchronous step, so the conversation cannot change between them. The
 * rows are deleted first; the files are removed once the rows are gone, so a
 * conversation is never left without its files. When the files cannot be
 * removed, the failure is logged with its cause and the deletion still
 * succeeds: the conversation is gone, and the files stay under the
 * attachments directory.
 */
async function handleDeleteConversation(
  request: FastifyRequest<DeleteConversationApiRoute>,
  reply: FastifyReply<DeleteConversationApiRoute>,
  deletion: ConversationDeletion
): Promise<void> {
  const { conversationId } = request.params
  const jobProblem = findConversationIsJobProblem(
    deletion.reader,
    conversationId,
    request.url
  )
  if (jobProblem !== undefined) {
    reply.type("application/problem+json").code(409).send(jobProblem)
    return
  }
  if (!deletion.history.deleteConversation(conversationId)) {
    reply
      .type("application/problem+json")
      .code(404)
      .send(createConversationNotFoundProblem(conversationId, request.url))
    return
  }
  try {
    await deletion.attachmentFiles.deleteConversationAttachments(conversationId)
  } catch (error) {
    request.log.error(
      { err: error },
      "The deleted conversation's attachment files could not be removed"
    )
  }
  reply.code(204).send()
}
