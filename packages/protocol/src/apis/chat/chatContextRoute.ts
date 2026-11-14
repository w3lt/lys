import { llmModelReferenceSchema } from "@lys/share"
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
import {
  areToolCallsSwitchedOffSchema,
  chatConversationTargetSchema,
  chatToolOfferSchema,
  hasDistinctToolChoiceNames,
  hasNoToolListWhileToolCallsOff,
  switchedOffToolNamesSchema,
  TOOL_LIST_WHILE_TOOL_CALLS_OFF_MESSAGE,
  TOOL_NAMED_TWICE_MESSAGE,
  unavailableToolsSchema
} from "./chatRoute"
import { apiChatContextRoute } from "./routes"

/**
 * Validates a request to measure the context a conversation's next message
 * would be sent with.
 *
 * @remarks Names the conversation, model, offered tools, switched-off and
 * unavailable tools, and whether tool calls are off exactly as the chat
 * request that would send the message names them; the message's text is not
 * part of the measurement. The tool fields pass the chat request's checks
 * across them.
 */
export const chatContextApiRequestBodySchema = z
  .strictObject({
    /** Conversation the next message would start or continue. */
    conversation: chatConversationTargetSchema,
    /** Model the message would be sent to, with its provider. */
    model: llmModelReferenceSchema,
    /** Tools the message would offer; absence means none. */
    tools: chatToolOfferSchema.optional(),
    /**
     * Tools the person switched off, by name; absence means none is. The
     * measurement counts the note that tells the model they are off.
     */
    switchedOffToolNames: switchedOffToolNamesSchema.optional(),
    /**
     * Switched-on backend tools that cannot run now, each with why; absence
     * means none. The measurement counts the note that tells the model so.
     */
    unavailableTools: unavailableToolsSchema.optional(),
    /**
     * `true` when the person switched tool calls off; absence means they
     * are on. The measurement counts the note that tells the model so.
     */
    areToolCallsSwitchedOff: areToolCallsSwitchedOffSchema.optional()
  })
  .refine(hasDistinctToolChoiceNames, TOOL_NAMED_TWICE_MESSAGE)
  .refine(
    hasNoToolListWhileToolCallsOff,
    TOOL_LIST_WHILE_TOOL_CALLS_OFF_MESSAGE
  )

/** Validates a whole number of tokens. */
const tokenCountSchema = z.int().nonnegative()

/**
 * Validates how much of the model's context window a conversation takes
 * before its next message's text.
 *
 * @remarks Counts are tokens of the loaded model's own tokenizer, each with an
 * allowance for the chat template's markup around it.
 */
export const chatContextApiResponseSchema = z
  .strictObject({
    /** Context length the model is loaded with; a positive integer. */
    contextLength: z.int().positive(),
    /**
     * Tokens of the answering agent's system prompt, with the note about the
     * tools the request does not offer when it names any or switches tool
     * calls off, and the note that tells the model to call `find_tools` when
     * the turn would route its tools.
     */
    systemPromptTokens: tokenCountSchema,
    /**
     * Tokens of the tool definitions a turn's first round would offer; 0
     * when none are offered.
     */
    toolTokens: tokenCountSchema,
    /** Tokens of the stored messages the next turn would include. */
    historyTokens: tokenCountSchema,
    /** Number of stored messages the next turn would include. */
    historyMessageCount: tokenCountSchema,
    /**
     * Tokens the next message takes without its text: the chat template's
     * markup around it. A client adds its own count of the text.
     */
    messageMarkupTokens: tokenCountSchema
  })
  .readonly()

/**
 * Selects the validator of a chat-context failure by HTTP status.
 *
 * @remarks A 404 is the agent-not-found problem when a new conversation names
 * a code no agent has, a deleted agent's, or Armitage's, which answers no
 * chat, and the conversation-not-found problem when a
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
 * the agent's current system prompt, the stored messages a turn includes, an
 * empty new message, and the tools that round would offer, then counts it
 * with the loaded model's tokenizer and reports the context length the model
 * is loaded with. For a model trained for tool use, the offered client,
 * built-in, and MCP tools are routed: `find_tools` is measured in their
 * place, and the note that tells the model to call it ends the system
 * prompt. Nothing is stored and the model is never loaded or asked to
 * generate. The measurement shares the model-operation queue, so it waits
 * behind a load in progress. An offered built-in backend tool is measured
 * whether or not it can run now; an offered MCP tool is measured only while
 * its server is connected, because its definition is known only then. The
 * descriptor is imported by backend and desktop transport code; changing its
 * method, path, or schemas is a compatibility change requiring coordinated
 * consumers.
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
