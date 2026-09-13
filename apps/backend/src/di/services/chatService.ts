import { OpenAI } from "openai"
import type {
  ChatCompletion,
  ChatCompletionMessageParam
} from "openai/resources/index.mjs"
import * as z from "zod"
import { titleGenerationPrompt } from "../../utils/prompts"
import { zodResponseFormat } from "openai/helpers/zod"
import type { MessageGenerationOptions } from "@lys/protocol"
import { TitleGenerationOutputError } from "../../utils/errors"

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
const titleGenerationOutputSchema = z.object({
  /** Generated title before the service trims and validates non-emptiness. */
  title: z.string()
})

/** Structured title output parsed from a reply, before trimming. */
type TitleGenerationOutput = z.infer<typeof titleGenerationOutputSchema>

/** Fallback credential value for unauthenticated OpenAI-compatible local endpoints. */
const DUMMY_API_KEY = "dummy-api-key"

/**
 * Owns an OpenAI client that adapts chat and title generation to the backend's
 * OpenAI-compatible local endpoint.
 *
 * @remarks The instance
 * owns its SDK client for its application lifetime; request inputs are borrowed
 * and cancellation is owned by each caller. Concurrency model: reentrant at
 * this service boundary; no request-local mutable state is retained and
 * request concurrency is delegated to the SDK.
 */
export default class ChatService {
  /** Owned OpenAI SDK client used to create chat completions. */
  #openaiClient: OpenAI

  /**
   * Creates a chat completion adapter for an endpoint and optional credential.
   *
   * @param options - Endpoint and optional credential used to create the client.
   */
  constructor({ openAiBaseUrl, apiKey }: ChatServiceCreationOptions) {
    this.#openaiClient = new OpenAI({
      baseURL: openAiBaseUrl,
      apiKey: apiKey ?? DUMMY_API_KEY
    })
  }

  /**
   * Starts a streamed chat completion against the configured endpoint.
   *
   * @param options - Messages, model selection, and optional cancellation signal for the request.
   * @returns A promise that resolves to the asynchronous stream of chat completion chunks after the request is established.
   * @throws If the request is rejected, aborted, or cannot be streamed by the configured endpoint.
   */
  public async completeChatStream({
    messages,
    model,
    signal,
    generationOptions
  }: CompleteChatOptions) {
    const { temperature, replyCeiling } = generationOptions
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
  }

  /**
   * Generates and validates one non-empty title from a user message.
   *
   * @remarks Makes one chat completion request whose response format asks the
   * endpoint to constrain the reply to the title JSON schema. The reply is
   * still parsed and validated because that enforcement depends on the
   * endpoint. The service adds no retries beyond the OpenAI SDK's transport
   * retries.
   * @param options - Message, model, and optional cancellation signal for the request.
   * @returns A promise that resolves to the trimmed generated title.
   * @throws {@link TitleGenerationOutputError} If the endpoint answers with a
   * reply that is truncated, has no content, is not JSON, does not match the
   * title shape, or contains a blank title.
   * @throws If the title prompt cannot be read, or the request is rejected,
   * cannot reach the endpoint, or is cancelled.
   */
  public async generateTitle({
    message,
    model,
    signal
  }: TitleGenerationOptions): Promise<string> {
    const titleInstructions = titleGenerationPrompt()
    const systemMessage: ChatCompletionMessageParam = {
      role: "system",
      content: titleInstructions
    }
    const userMessage: ChatCompletionMessageParam = {
      role: "user",
      content: message
    }
    const responseFormat = zodResponseFormat(
      titleGenerationOutputSchema,
      "title_generation"
    )

    const completion = await this.#openaiClient.chat.completions.create(
      {
        messages: [systemMessage, userMessage],
        model,
        response_format: responseFormat,
        stream: false
      },
      { signal }
    )

    return parseGeneratedTitle(completion)
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
 * Extracts the non-empty title from one title-generation chat completion.
 *
 * @param completion - Endpoint reply to a title request; its content is untrusted.
 * @returns The trimmed title.
 * @throws {@link TitleGenerationOutputError} If the reply stopped for a reason
 * other than `stop`, has no message content, is not JSON, does not match the
 * title shape, or contains a blank title.
 */
function parseGeneratedTitle(completion: ChatCompletion): string {
  const choice = completion.choices.find(({ index }) => index === 0)
  if (choice?.finish_reason !== "stop") {
    throw new TitleGenerationOutputError(
      `The title reply finished with reason "${choice?.finish_reason ?? "none"}"`
    )
  }

  const content = choice.message.content
  if (content === null) {
    throw new TitleGenerationOutputError("The title reply has no content")
  }

  const title = parseTitleOutput(content).title.trim()
  if (!title) {
    throw new TitleGenerationOutputError("The model generated a blank title")
  }

  return title
}

/**
 * Parses reply content into the structured title output.
 *
 * @param content - Untrusted message content returned by the endpoint.
 * @returns The validated title output before trimming.
 * @throws {@link TitleGenerationOutputError} If the content is not JSON or does
 * not match the title shape; the parse failure is kept as the cause.
 */
function parseTitleOutput(content: string): TitleGenerationOutput {
  const titleOutput = titleGenerationOutputSchema.safeParse(
    parseReplyJson(content)
  )
  if (!titleOutput.success) {
    throw new TitleGenerationOutputError(
      "The title reply does not match the title shape",
      { cause: titleOutput.error }
    )
  }

  return titleOutput.data
}

/**
 * Parses reply content as JSON.
 *
 * @param content - Untrusted message content returned by the endpoint.
 * @returns The parsed, still untrusted JSON value.
 * @throws {@link TitleGenerationOutputError} If the content is not valid JSON;
 * the syntax error is kept as the cause.
 */
function parseReplyJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new TitleGenerationOutputError("The title reply is not valid JSON", {
      cause: error
    })
  }
}
