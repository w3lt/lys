import * as z from "zod"

/** Validates ISO-8601 timestamps persisted with exactly millisecond precision. */
const timestampSchema = z.iso.datetime({ precision: 3 })

/** Lifecycle states permitted for a persisted assistant message. */
const conversationAssistantMessageStatusSchema = z.enum([
  "streaming",
  "completed",
  "interrupted",
  "failed"
])

/** Terminal model completion reasons shared with the chat stream `done` event. */
const conversationAssistantMessageFinishReasonSchema = z.enum([
  "stop",
  "length"
])

/** Common UUIDv7 identity and creation timestamp shared by both message roles. */
const conversationMessageBase = {
  /** UUIDv7 message identity used by persistence and stream updates. */
  id: z.uuidv7(),
  /** Creation time represented with the shared millisecond timestamp precision. */
  createdAt: timestampSchema
}

/** Validates a non-empty user-authored message in a persisted conversation. */
export const conversationUserMessageSchema = z.strictObject({
  ...conversationMessageBase,
  role: z.literal("user"),
  /** Non-empty authored content retained in the conversation transcript. */
  content: z.string().min(1)
})

/** Validates an assistant message, including its generation lifecycle state. */
export const conversationAssistantMessageSchema = z.strictObject({
  ...conversationMessageBase,
  /** Non-empty model identifier that produced or owns the reply. */
  model: z.string().min(1),
  role: z.literal("assistant"),
  /** May be empty before the first delta or when generation fails. */
  content: z.string(),
  status: conversationAssistantMessageStatusSchema,
  /** Null while the reply is streaming, interrupted, or failed. */
  finishReason: conversationAssistantMessageFinishReasonSchema.nullable(),
  /** Last modification time, updated as assistant content or state changes. */
  updatedAt: timestampSchema
})

/** Validates either role-specific message shape using the `role` discriminant. */
export const conversationMessageSchema = z.discriminatedUnion("role", [
  conversationUserMessageSchema,
  conversationAssistantMessageSchema
])

/** Validates the persisted conversation record and its ordered message history. */
export const conversationSchema = z.strictObject({
  id: z.uuidv7(),
  /** Optional until title generation completes; otherwise non-empty. */
  title: z.string().min(1).nullable(),
  /** Non-empty system instruction persisted with the conversation. */
  systemPrompt: z.string().min(1),
  /** Messages remain in persisted conversation order. */
  messages: z.array(conversationMessageSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})

/** Validates conversation metadata without the persisted message history. */
export const conversationMetadataSchema = conversationSchema.omit({
  messages: true
})

/** User-authored message accepted by the persisted conversation contract. */
export type ConversationUserMessage = z.infer<
  typeof conversationUserMessageSchema
>
/** Assistant message accepted by the persisted conversation contract. */
export type ConversationAssistantMessage = z.infer<
  typeof conversationAssistantMessageSchema
>
/** Either role-specific message accepted by the persisted conversation contract. */
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

/** Persisted conversation record including its ordered message history. */
export type Conversation = z.infer<typeof conversationSchema>

/** Persisted conversation metadata used when message history is not transferred. */
export type ConversationMetadata = z.infer<typeof conversationMetadataSchema>

/** Assistant message lifecycle state inferred from its authoritative schema. */
export type ConversationAssistantMessageStatus = z.infer<
  typeof conversationAssistantMessageStatusSchema
>

/** Model completion reason inferred from the authoritative conversation schema. */
export type ConversationAssistantMessageFinishReason = z.infer<
  typeof conversationAssistantMessageFinishReasonSchema
>
