import { apiChatRoute } from "../llm"
import * as z from "zod"
import {
  conversationAssistantMessageSchema,
  conversationMetadataSchema,
  conversationUserMessageSchema,
  lysPersonalitySchema
} from "@lys/share"
import {
  chatDeltaEventSchema,
  chatDoneEventSchema,
  chatErrorEventSchema,
  chatInterruptedEventSchema,
  chatTitleEventSchema
} from "./_share"

/** Inclusive maximum sampling temperature accepted by chat requests and their UI. */
export const MAXIMUM_GENERATION_TEMPERATURE = 1

/** Validates generation controls forwarded to the backend model completion. */
export const messageGenerationOptionsSchema = z.strictObject({
  /** Sampling temperature coerced to a number and constrained from zero through one. */
  temperature: z.coerce.number().min(0).max(MAXIMUM_GENERATION_TEMPERATURE),
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
  generationOptions: messageGenerationOptionsSchema,
  /**
   * Side of Lys's personality that answers this turn, as reported by the
   * desktop host when the request is sent. It selects the tone appended to
   * the conversation's stored system prompt for this turn only and is not
   * stored.
   */
  personality: lysPersonalitySchema
})

/**
 * Validates the discriminated SSE event variants emitted by the chat route.
 *
 * @remarks The backend emits a start event before generation events. Exactly
 * one of `done`, `interrupted`, or `error` ends the reply: `done` after the
 * completed reply is stored, `interrupted` when it ended early because it was
 * stopped, superseded by a newer turn, deleted, or cancelled by shutdown, and
 * `error` after a generation failure. A `title` event follows the start event
 * either to reconcile an existing persisted title or to publish a newly
 * persisted title. A generated title may arrive before, between, or after the
 * reply events because its task runs concurrently. The stream closes after
 * both tasks settle; like every generation stream (see
 * `ChatGenerationEvent`), it can close without a final reply event. The
 * `type` discriminant is the compatibility boundary used by desktop
 * consumers.
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

  chatTitleEventSchema,
  chatDeltaEventSchema,
  chatDoneEventSchema,
  chatInterruptedEventSchema,
  chatErrorEventSchema
])

/**
 * Describes the POST chat endpoint and its text/event-stream response contract.
 *
 * @remarks Strict request and event schemas reject unknown fields. The required
 * generation options and personality have no protocol-level default; an
 * omitted `replyCeiling` remains absent and is translated by the backend
 * runtime.
 * Closing the response stream ends only this client's observation: the
 * backend keeps generating and storing the reply and its title. The
 * reply-stop endpoint stops a reply, and the reply-events endpoint follows it
 * again. The descriptor is imported by backend and desktop transport code;
 * changing its method, path, status, content type, or schemas is a
 * compatibility change requiring coordinated consumers.
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
