import { apiChatRoute } from "../llm"
import * as z from "zod"
import {
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationUserMessageSchema
} from "@lys/share"

/** Validates generation controls forwarded to the backend model completion. */
export const messageGenerationOptionsSchema = z.strictObject({
  /** Sampling temperature coerced to a number and constrained from zero through one. */
  temperature: z.coerce.number().min(0).max(1),
  /** Optional non-negative maximum completion-token count. */
  replyCeiling: z.coerce.number().int().min(0).optional()
})

/** Validates a chat request with an optional existing conversation identity. */
export const chatApiRequestBodySchema = z.strictObject({
  /** Omit to start a new conversation; provide a UUIDv7 to continue one. */
  conversationId: z.uuidv7().optional(),
  /** Non-empty user-authored prompt sent to the selected model. */
  message: z.string().min(1),
  /** Non-empty model identifier resolved by the backend runtime. */
  model: z.string().min(1),
  /** Required generation controls; absence is not represented by this contract. */
  generationOptions: messageGenerationOptionsSchema
})

/**
 * Validates the discriminated SSE event variants emitted by the chat route.
 *
 * @remarks The backend emits a start event before generation events. A `done`
 * event terminates successful model generation; title and error events may be
 * emitted by concurrent route tasks as they settle. The `type` discriminant is
 * the compatibility boundary used by desktop consumers.
 */
export const chatApiStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start-new-conversation-turn"),
    /** Metadata for the newly created conversation. */
    conversation: conversationMetadataSchema,
    /** Persisted user message created before generation starts. */
    userMessage: conversationUserMessageSchema,
    /** Empty or in-progress assistant message that receives deltas. */
    assistantMessage: conversationAssistantMessageSchema
  }),

  z.strictObject({
    type: z.literal("start-existing-conversation-turn"),
    /** Persisted user message appended to the existing conversation. */
    userMessage: conversationUserMessageSchema,
    /** Empty or in-progress assistant message that receives deltas. */
    assistantMessage: conversationAssistantMessageSchema
  }),

  z.strictObject({
    type: z.literal("title"),
    /** Non-empty title generated for the conversation. */
    title: z.string().min(1)
  }),

  z.strictObject({
    type: z.literal("delta"),
    /** Non-empty assistant content fragment in stream order. */
    content: z.string().min(1)
  }),

  z.strictObject({
    type: z.literal("done"),
    /** Terminal model reason for a successfully completed assistant reply. */
    finishReason: z.enum(["stop", "length"])
  }),

  z.strictObject({
    type: z.literal("error"),
    /** Non-empty user-presentable stream failure message. */
    message: z.string().min(1)
  })
])

/**
 * Describes the POST chat endpoint and its text/event-stream response contract.
 *
 * @remarks Strict request and event schemas reject unknown fields. The required
 * generation options have no protocol-level default; an omitted
 * `replyCeiling` remains absent and is translated by the backend runtime.
 * The descriptor is imported by backend and desktop transport code; changing
 * its method, path, status, content type, or schemas is a compatibility change
 * requiring coordinated consumers.
 */
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

/** Request body accepted by the chat route after schema validation. */
export type ChatApiRequestBody = z.infer<typeof chatApi.body>

/** Response descriptor inferred from the chat route contract. */
export type ChatApiResponse = z.infer<typeof chatApi.response>

/** Typed event union accepted by the chat SSE transport. */
export type ChatApiStreamEvent = z.infer<typeof chatApiStreamEventSchema>

/** Generation controls accepted by the chat request contract. */
export type MessageGenerationOptions = z.infer<
  typeof messageGenerationOptionsSchema
>

/** Fastify route type carrying the validated chat request body. */
export type ChatApiRoute = {
  /** Validated request payload supplied to the backend handler. */
  Body: ChatApiRequestBody
}
