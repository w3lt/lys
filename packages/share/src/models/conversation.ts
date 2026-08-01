import * as z from "zod"

const timestampSchema = z.iso.datetime({ precision: 3 })

const conversationAssistantMessageStatusSchema = z.enum([
  "streaming",
  "completed",
  "interrupted",
  "failed"
])

// Prefer sharing this with the SSE `done` event schema.
const conversationAssistantMessageFinishReasonSchema = z.enum([
  "stop",
  "length"
])

const conversationMessageBase = {
  id: z.uuidv7(),
  model: z.string().min(1),
  createdAt: timestampSchema
}

export const conversationUserMessageSchema = z.strictObject({
  ...conversationMessageBase,
  role: z.literal("user"),
  content: z.string().min(1)
})

export const conversationAssistantMessageSchema = z.strictObject({
  ...conversationMessageBase,
  role: z.literal("assistant"),
  content: z.string(), // Maybe empty before the first delta or when generation fails.
  status: conversationAssistantMessageStatusSchema,
  // Null while streaming, interrupted, or failed.
  finishReason: conversationAssistantMessageFinishReasonSchema.nullable(),
  updatedAt: timestampSchema
})

export const conversationMessageSchema = z.discriminatedUnion("role", [
  conversationUserMessageSchema,
  conversationAssistantMessageSchema
])

export const conversationSchema = z.strictObject({
  id: z.uuidv7(),
  title: z.string().min(1).nullable(),
  systemPrompt: z.string().min(1),
  messages: z.array(conversationMessageSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})

export const conversationMetadataSchema = conversationSchema.omit({
  messages: true
})

export type ConversationUserMessage = z.infer<
  typeof conversationUserMessageSchema
>
export type ConversationAssistantMessage = z.infer<
  typeof conversationAssistantMessageSchema
>
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

export type Conversation = z.infer<typeof conversationSchema>

export type ConversationMetadata = z.infer<typeof conversationMetadataSchema>
