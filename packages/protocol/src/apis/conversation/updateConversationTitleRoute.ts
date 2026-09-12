import * as z from "zod"
import { conversationMetadataSchema } from "@lys/share"
import {
  conversationNotFoundProblemSchema,
  type ConversationNotFoundProblem
} from "../../http/errors/conversation"
import {
  conversationPathParamsSchema,
  type ConversationPathParams
} from "./_share"
import { apiConversationRoute } from "./routes"

/**
 * Inclusive maximum conversation-title length accepted through the API,
 * counted in UTF-16 code units after trimming surrounding whitespace.
 *
 * @remarks Transmitted limit shared by the title-update endpoint and its
 * clients, which use it to bound title entry. Titles persisted before this
 * limit, including generated titles, are not rewritten by it. Lowering it can
 * reject titles that clients accept.
 */
export const MAXIMUM_CONVERSATION_TITLE_LENGTH = 120

/**
 * Validates the body of a conversation title replacement.
 *
 * @remarks The title is trimmed before validation; an empty result is
 * rejected. This is a replacement of the single `title` field, not a general
 * partial update of conversation metadata.
 */
const updateConversationTitleApiRequestBodySchema = z
  .strictObject({
    /** Replacement title shown in conversation history. */
    title: z.string().trim().min(1).max(MAXIMUM_CONVERSATION_TITLE_LENGTH)
  })
  .readonly()

/** Selects the title-update failure validator by HTTP status. */
const updateConversationTitleApiResponseSchemas = Object.freeze({
  404: conversationNotFoundProblemSchema
})

/**
 * Describes the PATCH endpoint that replaces one stored conversation's title.
 *
 * @remarks Success persists the trimmed title before responding with the
 * resulting conversation metadata. Renaming does not change the conversation's
 * activity time, so its position in the newest-first list is unchanged.
 * Repeating the same request is idempotent. A missing conversation returns the
 * conversation-not-found problem with HTTP 404 and changes nothing. Changing
 * the method, path, or schemas requires coordinated consumers.
 */
export const updateConversationTitleApi = Object.freeze({
  method: "PATCH",
  path: apiConversationRoute,
  params: conversationPathParamsSchema,
  body: updateConversationTitleApiRequestBodySchema,
  response: conversationMetadataSchema,
  responses: updateConversationTitleApiResponseSchemas
})

/** Validated body accepted by the title-update endpoint. */
export type UpdateConversationTitleApiRequestBody = z.infer<
  typeof updateConversationTitleApi.body
>

/** Conversation metadata returned after a persisted title replacement. */
export type UpdateConversationTitleApiResponse = z.infer<
  typeof updateConversationTitleApi.response
>

/** Status-specific payloads returned by the title-update endpoint. */
export type UpdateConversationTitleApiReply = {
  /** Metadata carrying the persisted replacement title. */
  readonly 200: UpdateConversationTitleApiResponse
  /** No conversation is stored under the addressed identifier. */
  readonly 404: ConversationNotFoundProblem
}

/** Fastify route type for the title-update endpoint. */
export type UpdateConversationTitleApiRoute = {
  /** Validated identifier of the conversation to rename. */
  readonly Params: ConversationPathParams
  /** Validated replacement title. */
  readonly Body: UpdateConversationTitleApiRequestBody
  /** Status-specific metadata and Problem Details payloads. */
  readonly Reply: UpdateConversationTitleApiReply
}
