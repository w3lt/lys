import type { OpenAIFunctionTool } from "@lys/share"
import type {
  ReplyContextMeasurement,
  ReplyContextMeasurementRequest,
  ReplyContextMeter
} from "../agent/replyContextMeter"
import type { ReplyContextMessage } from "../agent/replyModel"
import type { LlmContextMeasurement } from "../llm/llmRuntimeTypes"

/** Measures texts with a loaded model's tokenizer; the LLM service's query. */
type FindLlmContextMeasurement = (
  model: string,
  texts: readonly string[]
) => Promise<LlmContextMeasurement | undefined>

/**
 * Tokens allowed for the markup a chat template adds around one message: its
 * role markers and separators.
 *
 * @remarks Common templates (ChatML, Gemma, Llama 3) add four to six tokens
 * per message; the rest covers the start of the request and the header that
 * opens the reply.
 */
const MESSAGE_TEMPLATE_TOKENS = 8

/**
 * Tokens allowed for the markup a chat template adds around one tool call in
 * an earlier round, such as the tags and keys that wrap its name and
 * arguments.
 */
const TOOL_CALL_TEMPLATE_TOKENS = 16

/**
 * Tokens allowed for the instructions a chat template adds once when tools
 * are offered, which introduce the tool list and say how to call a tool.
 *
 * @remarks ChatML templates with tools, such as Qwen 3's, add about one
 * hundred tokens.
 */
const TOOL_OFFER_TEMPLATE_TOKENS = 160

/**
 * Measures reply contexts with the tokenizer of the loaded model they are
 * sent to.
 *
 * @remarks Implements {@link ReplyContextMeter}. Each message is counted as
 * the text the model reads: its content, and the name and argument text of
 * each tool call it carries; each offered tool as its JSON. LM Studio wraps
 * them in the model's chat template, which this class does not render, so a
 * fixed allowance for the template's markup is added to each message, each
 * earlier tool call, and the tool offer. Owns no resource: the LLM service's
 * owner releases the runtime. Concurrency model: reentrant; it keeps no
 * state, and the borrowed query serializes its own work.
 */
export default class LlmReplyContextMeter implements ReplyContextMeter {
  /** Borrowed query of the backend's LLM service. */
  readonly #findLlmContextMeasurement: FindLlmContextMeasurement

  /**
   * Creates the meter without contacting the model's runtime.
   * @param findLlmContextMeasurement - Query lent for the meter's lifetime.
   */
  public constructor(findLlmContextMeasurement: FindLlmContextMeasurement) {
    this.#findLlmContextMeasurement = findLlmContextMeasurement
  }

  /**
   * Implements {@link ReplyContextMeter.findReplyContextMeasurement}.
   * @param request - Interface-defined context, tools, and model.
   * @returns The interface-defined measurement: each count is the text's
   * tokens plus the template allowance; or undefined when the model is not
   * loaded.
   * @throws The borrowed query's failure unchanged, or if its measurement
   * lacks a count for a message.
   */
  public async findReplyContextMeasurement(
    request: ReplyContextMeasurementRequest
  ): Promise<ReplyContextMeasurement | undefined> {
    const measurement = await this.#findLlmContextMeasurement(request.model, [
      ...request.messages.map(buildMessageText),
      ...request.tools.map(buildToolText)
    ])
    if (measurement === undefined) return undefined
    const messageCount = request.messages.length
    const { textTokenCounts } = measurement
    return Object.freeze({
      contextLength: measurement.contextLength,
      messageTokenCounts: Object.freeze(
        request.messages.map((message, index) =>
          calculateMessageTokens(
            message,
            getTextTokenCount(textTokenCounts, index)
          )
        )
      ),
      toolTokenCount: calculateToolOfferTokens(
        textTokenCounts.slice(messageCount)
      )
    })
  }
}

/**
 * Gets the token count of one measured text.
 *
 * @param textTokenCounts - Counts of the measured texts, in text order.
 * @param index - Position of the text.
 * @returns The text's count.
 * @throws If the measurement holds no count at that position, which breaks
 * the query's one-count-per-text contract.
 */
function getTextTokenCount(
  textTokenCounts: readonly number[],
  index: number
): number {
  const textTokens = textTokenCounts[index]
  if (textTokens === undefined)
    throw new Error(`The context measurement has no count for text ${index}`)
  return textTokens
}

/**
 * Builds the text the model reads for one message.
 *
 * @param message - Context message.
 * @returns Its content; for an assistant message, followed by the name and
 * argument text of each call it carries, one call per line.
 */
function buildMessageText(message: ReplyContextMessage): string {
  if (message.role !== "assistant") return message.content
  return [
    message.content,
    ...message.toolCalls.map(
      (toolCall) => `${toolCall.toolName} ${toolCall.argumentText}`
    )
  ].join("\n")
}

/**
 * Builds the text the model reads for one offered tool.
 *
 * @param tool - Offered function tool.
 * @returns Its JSON, as chat templates list a tool.
 */
function buildToolText(tool: OpenAIFunctionTool): string {
  return JSON.stringify(tool)
}

/**
 * Calculates the tokens one message takes in the request.
 *
 * @param message - Context message.
 * @param textTokens - Tokens of the message's text.
 * @returns The text's tokens plus the message's template allowance and, for
 * an assistant message, each of its calls' allowance.
 */
function calculateMessageTokens(
  message: ReplyContextMessage,
  textTokens: number
): number {
  const toolCallCount =
    message.role === "assistant" ? message.toolCalls.length : 0
  return (
    textTokens +
    MESSAGE_TEMPLATE_TOKENS +
    toolCallCount * TOOL_CALL_TEMPLATE_TOKENS
  )
}

/**
 * Calculates the tokens the offered tools take in the request.
 *
 * @param toolTextTokenCounts - Tokens of each offered tool's JSON.
 * @returns 0 when no tool is offered; otherwise their tokens plus the tool
 * offer's template allowance.
 */
function calculateToolOfferTokens(
  toolTextTokenCounts: readonly number[]
): number {
  if (toolTextTokenCounts.length === 0) return 0
  return toolTextTokenCounts.reduce(
    (total, toolTokens) => total + toolTokens,
    TOOL_OFFER_TEMPLATE_TOKENS
  )
}
