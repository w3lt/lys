import { APIUserAbortError, OpenAI } from "openai"
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ResponseFormatJSONSchema
} from "openai/resources/index.mjs"
import * as z from "zod"
import { zodResponseFormat } from "openai/helpers/zod"
import type { MessageGenerationOptions } from "@lys/protocol"
import {
  ChatCompletionCancelledError,
  TitleGenerationOutputError
} from "../../utils/errors"

/** Settings used to create an application-scoped OpenAI-compatible chat client. */
export type ChatServiceCreationOptions = {
  /** Base URL of the OpenAI-compatible chat completion endpoint. */
  openAiBaseUrl: string
  /**
   * Optional endpoint credential.
   *
   * @remarks Defaults to a non-secret placeholder because local OpenAI-compatible servers require a value but may not authenticate it.
   */
  apiKey?: string
  /** Non-empty system prompt sent with every title-generation request. */
  titleGenerationPrompt: string
  /**
   * Inclusive maximum length of a generated title, in Unicode code points,
   * before surrounding whitespace is trimmed.
   *
   * @remarks A positive safe integer, validated when the backend configuration
   * is loaded.
   */
  generatedTitleMaxLength: number
}

/** Inputs shared by chat completion requests. */
export type CompleteChatOptions = {
  /** Ordered conversation messages sent to the configured model. */
  messages: ChatCompletionMessageParam[]
  /** Identifier of the model that should generate the completion. */
  model: string
  /**
   * Whether the caller requested streaming in the shared option shape.
   *
   * @remarks {@link ChatService["completeChatStream"]} always requests streaming.
   */
  stream?: boolean
  /** Abort signal that cancels the in-flight completion request. */
  signal?: AbortSignal
  /** Sampling and completion-length controls forwarded to the model request. */
  generationOptions: MessageGenerationOptions
}

/** Inputs used to generate a structured conversation title from one user message. */
export type TitleGenerationOptions = {
  /** User-authored message supplied as the title-generation input. */
  message: string
  /** Identifier of the model that generates the title. */
  model: string
  /** Optional signal that cancels the title-generation request. */
  signal?: AbortSignal
}

/**
 * Validates the structured title in a title-generation reply and defines the
 * JSON schema the endpoint is asked to enforce.
 */
type TitleGenerationOutputSchema = ReturnType<
  typeof buildTitleGenerationOutputSchema
>

/** Structured title output parsed from a reply, before trimming. */
type TitleGenerationOutput = z.infer<TitleGenerationOutputSchema>

/** Fallback credential value for unauthenticated OpenAI-compatible local endpoints. */
const DUMMY_API_KEY = "dummy-api-key"

/**
 * Matches reply content wrapped in one Markdown code fence, with an optional
 * `json` language tag, and captures the fenced text.
 */
const MARKDOWN_JSON_CODE_FENCE_PATTERN = /^```(?:json)?([\s\S]*)```$/i

/**
 * Owns an OpenAI client that adapts chat and title generation to the backend's
 * OpenAI-compatible local endpoint.
 *
 * @remarks The instance
 * owns its SDK client and its title prompt and schema for its application
 * lifetime; request inputs are borrowed and cancellation is owned by each
 * caller. Concurrency model: reentrant at this service boundary; no
 * request-local mutable state is retained and request concurrency is delegated
 * to the SDK.
 */
export default class ChatService {
  /** Owned OpenAI SDK client used to create chat completions. */
  #openaiClient: OpenAI
  /** Frozen system message sent before the user message in every title request. */
  readonly #titleSystemMessage: ChatCompletionMessageParam
  /** Validates title replies, including the configured title length limit. */
  readonly #titleOutputSchema: TitleGenerationOutputSchema
  /** Response format asking the endpoint to enforce the title output schema. */
  readonly #titleResponseFormat: ResponseFormatJSONSchema

  /**
   * Creates a chat completion adapter for an endpoint, an optional credential,
   * and the title-generation settings.
   *
   * @param options - Endpoint, optional credential, title prompt, and title
   * length limit used to create the client and title request parts.
   */
  constructor({
    openAiBaseUrl,
    apiKey,
    titleGenerationPrompt,
    generatedTitleMaxLength
  }: ChatServiceCreationOptions) {
    const titleOutputSchema = buildTitleGenerationOutputSchema(
      generatedTitleMaxLength
    )

    this.#openaiClient = new OpenAI({
      baseURL: openAiBaseUrl,
      apiKey: apiKey ?? DUMMY_API_KEY
    })
    this.#titleSystemMessage = Object.freeze({
      role: "system",
      content: titleGenerationPrompt
    })
    this.#titleOutputSchema = titleOutputSchema
    this.#titleResponseFormat = zodResponseFormat(
      titleOutputSchema,
      "title_generation"
    )
  }

  /**
   * Starts a streamed chat completion against the configured endpoint.
   *
   * @param options - Messages, model selection, and optional cancellation signal for the request.
   * @returns A promise that resolves to the asynchronous stream of chat completion chunks after the request is established.
   * @throws {@link ChatCompletionCancelledError} If the SDK reports that
   * request creation was cancelled; the SDK failure is kept as the cause.
   * @throws If the request is otherwise rejected or cannot be streamed by the
   * configured endpoint.
   */
  public async completeChatStream({
    messages,
    model,
    signal,
    generationOptions
  }: CompleteChatOptions): Promise<AsyncIterable<ChatCompletionChunk>> {
    const { temperature, replyCeiling } = generationOptions
    try {
      return await this.#openaiClient.chat.completions.create(
        {
          messages,
          model,
          stream: true,
          temperature,
          max_completion_tokens: replyCeiling ?? null
        },
        { signal }
      )
    } catch (error) {
      if (error instanceof APIUserAbortError) {
        throw new ChatCompletionCancelledError(error)
      }

      throw error
    }
  }

  /**
   * Generates and validates one non-empty title from a user message.
   *
   * @remarks Makes one chat completion call with the configured title prompt
   * and a response format that asks the endpoint to constrain the reply to the
   * title JSON schema, including its length limit. The reply is still parsed
   * and validated because that enforcement depends on the endpoint; JSON
   * wrapped in one Markdown code fence is accepted. The service adds no retries
   * of its own. The OpenAI SDK can send the request up to three times when it
   * retries a connection failure, timeout, or 408, 409, 429, or 5xx response.
   * @param options - Message, model, and optional cancellation signal for the request.
   * @returns A promise that resolves to the trimmed generated title.
   * @throws {@link TitleGenerationOutputError} If the endpoint answers with a
   * reply that is truncated, has no content, is not JSON, does not match the
   * title shape, has a title longer than the limit, or contains a blank title.
   * @throws If the request is rejected, cannot reach the endpoint, or is
   * cancelled.
   */
  public async generateTitle({
    message,
    model,
    signal
  }: TitleGenerationOptions): Promise<string> {
    const userMessage: ChatCompletionMessageParam = {
      role: "user",
      content: message
    }

    const completion = await this.#openaiClient.chat.completions.create(
      {
        messages: [this.#titleSystemMessage, userMessage],
        model,
        response_format: this.#titleResponseFormat,
        stream: false
      },
      { signal }
    )

    return parseGeneratedTitle(completion, this.#titleOutputSchema)
  }

  /**
   * Completes asynchronous disposal of this adapter.
   *
   * @returns A promise that resolves immediately.
   * @remarks The current OpenAI client exposes no asynchronous cleanup requirement.
   */
  public async [Symbol.asyncDispose]() {}
}

/**
 * Builds the schema that validates a title-generation reply and defines the
 * JSON schema the endpoint is asked to enforce.
 *
 * @param generatedTitleMaxLength - Inclusive maximum title length, in Unicode
 * code points, before trimming.
 * @returns A schema accepting an object whose `title` is a string no longer
 * than the limit.
 */
function buildTitleGenerationOutputSchema(generatedTitleMaxLength: number) {
  return z.object({
    /** Generated title before the service trims it and rejects a blank value. */
    title: z.string().max(generatedTitleMaxLength)
  })
}

/**
 * Extracts the non-empty title from one title-generation chat completion.
 *
 * @param completion - Endpoint reply to a title request; its content is untrusted.
 * @param titleOutputSchema - Schema enforcing the title shape and length limit.
 * @returns The trimmed title.
 * @throws {@link TitleGenerationOutputError} If the reply stopped for a reason
 * other than `stop`, has no message content, is not JSON, does not match the
 * title shape, has a title longer than the limit, or contains a blank title.
 */
function parseGeneratedTitle(
  completion: ChatCompletion,
  titleOutputSchema: TitleGenerationOutputSchema
): string {
  const choice = completion.choices.find(({ index }) => index === 0)
  if (choice?.finish_reason !== "stop") {
    throw new TitleGenerationOutputError(
      `The title reply finished with reason "${choice?.finish_reason ?? "none"}"`
    )
  }

  const content = choice.message.content
  if (typeof content !== "string") {
    throw new TitleGenerationOutputError(
      "The title reply content is not a string"
    )
  }

  const title = parseTitleOutput(content, titleOutputSchema).title.trim()
  if (!title) {
    throw new TitleGenerationOutputError("The model generated a blank title")
  }

  return title
}

/**
 * Parses reply content into the structured title output.
 *
 * @param content - Untrusted message content returned by the endpoint.
 * @param titleOutputSchema - Schema enforcing the title shape and length limit.
 * @returns The validated title output before trimming.
 * @throws {@link TitleGenerationOutputError} If the content is not JSON, does
 * not match the title shape, or has a title longer than the limit; the parse
 * failure is kept as the cause.
 */
function parseTitleOutput(
  content: string,
  titleOutputSchema: TitleGenerationOutputSchema
): TitleGenerationOutput {
  const titleOutput = titleOutputSchema.safeParse(parseReplyJson(content))
  if (!titleOutput.success) {
    throw new TitleGenerationOutputError(
      "The title reply does not match the title shape or length limit",
      { cause: titleOutput.error }
    )
  }

  return titleOutput.data
}

/**
 * Parses reply content as JSON, unwrapping one surrounding Markdown code fence.
 *
 * @remarks An endpoint that does not enforce the response format can wrap the
 * requested JSON in a fence. Unwrapping it keeps that reply usable instead of
 * spending another title request on the same formatting.
 * @param content - Untrusted message content returned by the endpoint.
 * @returns The parsed, still untrusted JSON value.
 * @throws {@link TitleGenerationOutputError} If the content, after any fence is
 * unwrapped, is not valid JSON; the syntax error is kept as the cause.
 */
function parseReplyJson(content: string): unknown {
  const fencedJson = MARKDOWN_JSON_CODE_FENCE_PATTERN.exec(content.trim())?.[1]

  try {
    return JSON.parse(fencedJson ?? content)
  } catch (error) {
    throw new TitleGenerationOutputError("The title reply is not valid JSON", {
      cause: error
    })
  }
}
