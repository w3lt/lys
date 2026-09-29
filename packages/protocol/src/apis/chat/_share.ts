import * as z from "zod"

/**
 * Validates the path parameters addressing one assistant reply in its
 * conversation.
 *
 * @remarks Shared by the reply-events and reply-stop endpoints. Both decoded
 * identifiers must be UUIDv7; a malformed identifier is rejected with HTTP 400
 * before any lookup, so it never produces a not-found problem.
 */
export const chatReplyPathParamsSchema = z
  .strictObject({
    /** UUIDv7 identity of the conversation that holds the reply. */
    conversationId: z.uuidv7(),
    /** UUIDv7 identity of the assistant reply. */
    assistantMessageId: z.uuidv7()
  })
  .readonly()

/** Path parameters addressing one assistant reply in its conversation. */
export type ChatReplyPathParams = z.infer<typeof chatReplyPathParamsSchema>

/** Validates the event carrying the conversation's persisted title. */
export const chatTitleEventSchema = z.strictObject({
  type: z.literal("title"),
  /** Non-empty persisted title for the conversation. */
  title: z.string().min(1)
})

/** Validates one stored assistant text fragment, sent in stream order. */
export const chatDeltaEventSchema = z.strictObject({
  type: z.literal("delta"),
  /** Non-empty assistant content fragment in stream order. */
  content: z.string().min(1)
})

/** Validates the event reporting that the reply completed and was stored. */
export const chatDoneEventSchema = z.strictObject({
  type: z.literal("done"),
  /** Terminal model reason for a successfully completed assistant reply. */
  finishReason: z.enum(["stop", "length"])
})

/**
 * Validates the event reporting that the reply ended before the model
 * finished.
 *
 * @remarks Sent when the reply was stopped, superseded by a newer turn in its
 * conversation, deleted with its conversation, or cancelled by backend
 * shutdown. The stored reply, if it still exists, is `interrupted` with
 * exactly the content delivered before this event.
 */
export const chatInterruptedEventSchema = z.strictObject({
  type: z.literal("interrupted")
})

/** Validates the event reporting a reply generation failure. */
export const chatErrorEventSchema = z.strictObject({
  type: z.literal("error"),
  /** Non-empty user-presentable stream failure message. */
  message: z.string().min(1)
})

/**
 * Events a running generation produces for every stream that follows its
 * reply.
 *
 * @remarks Exactly one of `done`, `interrupted`, or `error` ends the reply. A
 * `title` event can arrive before, between, or after reply events because
 * title generation runs concurrently. A stream can also close without any of
 * the three: the backend ends a follower that falls too far behind, and a
 * reply whose final state cannot be stored sends none. Such a close says
 * nothing about the reply's outcome; following the reply again or reading
 * its conversation returns the stored state.
 */
export type ChatGenerationEvent =
  | z.infer<typeof chatTitleEventSchema>
  | z.infer<typeof chatDeltaEventSchema>
  | z.infer<typeof chatDoneEventSchema>
  | z.infer<typeof chatInterruptedEventSchema>
  | z.infer<typeof chatErrorEventSchema>
