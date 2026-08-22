import * as z from "zod"
import { conversationMetadataSchema } from "@lys/share"

/**
 * Short plain-text extract of one persisted message.
 *
 * @remarks The backend owns extraction: it strips message markup, collapses
 * whitespace, and truncates the result. `text` is therefore a presentation
 * excerpt and MUST NOT be treated as the stored message content.
 */
export const conversationMessageExcerptSchema = z.strictObject({
  /** Author of the excerpted message. */
  role: z.enum(["user", "assistant"]),
  /** Non-empty excerpt already trimmed and truncated by the backend. */
  text: z.string().min(1)
})

/**
 * One conversation as presented in the conversation history list.
 *
 * @remarks This is a read projection rather than the stored conversation. It
 * omits `systemPrompt` and messages, which the history list never displays.
 * `excerpt` is null only when the conversation holds no messages; when the
 * list request carries a search query the excerpt comes from the matched
 * message, otherwise from the most recent message.
 */
export const conversationSummarySchema = conversationMetadataSchema
  .omit({ systemPrompt: true })
  .extend({
    /** Message excerpt shown beside the title, or null when none exists. */
    excerpt: conversationMessageExcerptSchema.nullable()
  })

/** Short plain-text extract of one persisted message. */
export type ConversationMessageExcerpt = z.infer<
  typeof conversationMessageExcerptSchema
>

/** One conversation as presented in the conversation history list. */
export type ConversationSummary = z.infer<typeof conversationSummarySchema>
