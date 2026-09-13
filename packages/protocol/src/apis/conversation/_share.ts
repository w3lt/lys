import * as z from "zod"

/**
 * Validates the path parameters that address one stored conversation.
 *
 * @remarks Shared by the get, title-update, and delete conversation endpoints.
 * The decoded identifier must be a UUIDv7; a malformed identifier is rejected
 * before any conversation lookup, so it never produces a not-found problem.
 */
export const conversationPathParamsSchema = z
  .strictObject({
    /** UUIDv7 identity of the addressed conversation. */
    conversationId: z.uuidv7()
  })
  .readonly()

/** Path parameters addressing one stored conversation. */
export type ConversationPathParams = z.infer<
  typeof conversationPathParamsSchema
>
