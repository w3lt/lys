import * as z from "zod"
import { agentNotFoundProblemSchema } from "../../http/errors/agent"
import {
  conversationAgentMissingProblemSchema,
  conversationNotFoundProblemSchema
} from "../../http/errors/conversation"
import {
  llmModelNotLoadedProblemSchema,
  llmRuntimeUnavailableProblemSchema
} from "../../http/errors/llm"
import { llmServiceBusyProblemSchema } from "../../http/errors/llmServiceBusy"
import { chatConversationTargetSchema, chatToolOfferSchema } from "./chatRoute"
import { apiChatContextRoute } from "./routes"

/**
 * Validates a request to measure the context a conversation's next message
 * would be sent with.
 *
 * @remarks Names the conversation, model, and tools exactly as the chat
 * request that would send the message names them; the message itself is not
 * part of the measurement.
 */
export const chatContextApiRequestBodySchema = z.strictObject({
  /** Conversation the next message would start or continue. */
  conversation: chatConversationTargetSchema,
  /** Non-empty identifier of the model the message would be sent to. */
  model: z.string().min(1),
  /** Tools the message would offer; absence means none. */
  tools: chatToolOfferSchema.optional()
})

/** Validates a whole number of tokens. */
const tokenCountSchema = z.int().nonnegative()

/**
 * Validates how much of the model's context window a conversation takes
 * before its next message.
 *
 * @remarks Counts are tokens of the loaded model's own tokenizer, each with an
 * allowance for the chat template's markup around it.
 */
export const chatContextApiResponseSchema = z
  .strictObject({
    /** Context length the model is loaded with; a positive integer. */
    contextLength: z.int().positive(),
    /** Tokens of the answering agent's system prompt. */
    systemPromptTokens: tokenCountSchema,
    /** Tokens of the offered tool definitions; 0 when none are offered. */
    toolTokens: tokenCountSchema,
    /** Tokens of the stored messages the next turn would include. */
    historyTokens: tokenCountSchema,
    /** Number of stored messages the next turn would include. */
    historyMessageCount: tokenCountSchema
  })
  .readonly()

/**
 * Selects the validator of a chat-context failure by HTTP status.
 *
 * @remarks A 404 is the agent-not-found problem when a new conversation names
 * a code no agent has, and the conversation-not-found problem when a
 * continued conversation is not stored. A 409 is the conversation agent
 * missing problem. A 503 is the LLM service busy problem, the LLM runtime
 * unavailable problem, or the model-not-loaded problem when no loaded
 * instance matches the model.
 */
const chatContextApiResponseSchemas = Object.freeze({
  200: chatContextApiResponseSchema,
  404: z.union([agentNotFoundProblemSchema, conversationNotFoundProblemSchema]),
  409: conversationAgentMissingProblemSchema,
  503: z.union([
    llmServiceBusyProblemSchema,
    llmRuntimeUnavailableProblemSchema,
    llmModelNotLoadedProblemSchema
  ])
})

/**
 * Describes the POST endpoint that measures the context a conversation's next
 * message would be sent with.
 *
 * @remarks The backend builds the context as a turn's first round would, with
 * the agent's current system prompt, the stored messages a turn includes, and
 * the offered tools, then counts it with the loaded model's tokenizer and
 * reports the context length the model is loaded with. Nothing is stored and
 * the model is never loaded or asked to generate. The measurement shares the
 * model-operation queue, so it waits behind a load in progress. An offered
 * backend tool is measured whether or not it can run now. The descriptor is
 * imported by backend and desktop transport code; changing its method, path,
 * or schemas is a compatibility change requiring coordinated consumers.
 */
export const chatContextApi = Object.freeze({
  method: "POST",
  path: apiChatContextRoute,
  body: chatContextApiRequestBodySchema,
  responses: chatContextApiResponseSchemas
})

/** Request body accepted by the chat-context route after validation. */
export type ChatContextApiRequestBody = z.infer<
  typeof chatContextApiRequestBodySchema
>

/** Measurement returned by the chat-context route. */
export type ChatContextApiResponse = z.infer<
  typeof chatContextApiResponseSchema
>

/** Fastify route type carrying the validated chat-context request body. */
export type ChatContextApiRoute = {
  /** Validated request payload supplied to the backend handler. */
  Body: ChatContextApiRequestBody
}
