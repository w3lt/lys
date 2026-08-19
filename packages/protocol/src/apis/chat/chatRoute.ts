import { apiChatRoute } from "../llm"
import * as z from "zod"
import {
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationUserMessageSchema
} from "@lys/share"

export const messageGenerationOptionsSchema = z.strictObject({
  temperature: z.coerce.number().min(0).max(1),
  replyCeiling: z.coerce.number().int().min(0).optional()
})

export const chatApiRequestBodySchema = z.strictObject({
  conversationId: z.uuidv7().optional(),
  message: z.string().min(1),
  model: z.string().min(1),
  generationOptions: messageGenerationOptionsSchema
})

export const chatApiStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start-new-conversation-turn"),
    conversation: conversationMetadataSchema,
    userMessage: conversationUserMessageSchema,
    assistantMessage: conversationAssistantMessageSchema
  }),

  z.strictObject({
    type: z.literal("start-existing-conversation-turn"),
    userMessage: conversationUserMessageSchema,
    assistantMessage: conversationAssistantMessageSchema
  }),

  z.strictObject({
    type: z.literal("title"),
    title: z.string().min(1)
  }),

  z.strictObject({
    type: z.literal("delta"),
    content: z.string().min(1)
  }),

  z.strictObject({
    type: z.literal("done"),
    finishReason: z.enum(["stop", "length"])
  }),

  z.strictObject({
    type: z.literal("error"),
    message: z.string().min(1)
  })
])

export const chatApi = {
  method: "POST",
  path: apiChatRoute,
  body: chatApiRequestBodySchema,
  response: {
    status: 200,
    contentType: "text/event-stream",
    eventSchema: chatApiStreamEventSchema
  }
}

export type ChatApiRequestBody = z.infer<typeof chatApi.body>

export type ChatApiResponse = z.infer<typeof chatApi.response>

export type ChatApiStreamEvent = z.infer<typeof chatApiStreamEventSchema>

export type MessageGenerationOptions = z.infer<
  typeof messageGenerationOptionsSchema
>

export type ChatApiRoute = {
  Body: ChatApiRequestBody
}
